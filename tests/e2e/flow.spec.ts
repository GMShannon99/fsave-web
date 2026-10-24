import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGithub } from '../support/fakeGithub';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept, content-type, x-github-api-version',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after',
};

async function mockGithub(page: Page, fake: FakeGithub) {
  await page.route(/^https:\/\/(api|uploads)\.github\.com\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const r = fake.handle({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postDataBuffer() });
    await route.fulfill({ status: r.status, headers: { ...r.headers, ...CORS }, body: r.body === null ? undefined : r.body });
  });
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'fsave-e2e-'));
  const dir = join(root, 'My Project');
  mkdirSync(join(dir, 'docs', 'sub folder'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'readme.txt'), 'hello world\n');
  writeFileSync(join(dir, 'docs', 'sub folder', 'ünïcode 日本語.txt'), 'unicode content');
  writeFileSync(join(dir, 'docs', 'data.bin'), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'should be excluded');
  writeFileSync(join(dir, '.DS_Store'), 'junk');
  return dir;
}

test('save → browse → download', async ({ page }) => {
  const fake = new FakeGithub();
  await mockGithub(page, fake);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  // First run -> settings
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await page.screenshot({ path: 'screenshots/1-first-run.png', fullPage: true });
  await page.getByLabel('Token').fill(fake.token);
  await page.getByLabel(/Repository \(owner\/name\)/).fill('me/fsave-storage');
  await page.getByRole('button', { name: /Test connection/ }).click();
  await expect(page.getByText(/Connected to me\/fsave-storage/)).toBeVisible();
  await expect(page.getByText(/4990 \/ 5000 remaining/)).toBeVisible();
  await page.screenshot({ path: 'screenshots/2-settings-connected.png', fullPage: true });

  // Empty state
  await page.getByRole('link', { name: 'Saves' }).click();
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();
  await page.screenshot({ path: 'screenshots/3-empty.png', fullPage: true });

  // Save a folder
  await page.getByRole('link', { name: 'New save' }).click();
  await page.getByTestId('pick-folder').setInputFiles(makeFixture());
  await expect(page.getByText('3 of 5 files selected')).toBeVisible(); // node_modules + .DS_Store excluded
  await expect(page.getByLabel('Name')).toHaveValue('My Project');
  await page.getByLabel(/Tags/).fill('Work, project');
  await page.getByLabel('Note').fill('E2E note');
  await page.screenshot({ path: 'screenshots/4-review.png', fullPage: true });
  const commitsBefore = fake.commitCount();
  await page.getByRole('button', { name: /Save 3 files/ }).click();
  await expect(page.getByRole('heading', { name: '✔ Saved' })).toBeVisible();
  await page.screenshot({ path: 'screenshots/5-saved.png', fullPage: true });
  expect(fake.commitCount()).toBe(commitsBefore + 1);

  // Browse + search
  await page.getByRole('link', { name: 'Saves' }).click();
  await expect(page.getByRole('heading', { name: 'My Project' })).toBeVisible();
  await page.getByLabel('Search saves').fill('nomatch');
  await expect(page.getByText(/No saves match/)).toBeVisible();
  await page.getByLabel('Search saves').fill('ünïcode');
  await page.screenshot({ path: 'screenshots/6-browse.png', fullPage: true });
  await page.getByRole('link', { name: /My Project/ }).click();

  // Detail + downloads
  await expect(page.getByText('E2E note')).toBeVisible();
  await expect(page.getByText('3 files').first()).toBeVisible();
  await page.getByRole('button', { name: 'Expand docs' }).click();
  await page.screenshot({ path: 'screenshots/7-detail.png', fullPage: true });

  const zipDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download all (zip)' }).click();
  const dl = await zipDl;
  expect(dl.suggestedFilename()).toBe('My Project.zip');
  const zip = await JSZip.loadAsync(readFileSync(await dl.path()));
  expect(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name).sort()).toEqual([
    'My Project/docs/data.bin',
    'My Project/docs/sub folder/ünïcode 日本語.txt',
    'My Project/readme.txt',
  ]);
  expect(await zip.file('My Project/readme.txt')!.async('string')).toBe('hello world\n');
  await expect(page.getByText(/all 3 files verified/)).toBeVisible();

  const fileDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download My Project/readme.txt' }).click();
  expect((await fileDl).suggestedFilename()).toBe('readme.txt');

  // Nothing leaked and no CSP / runtime errors
  expect(errors, errors.join(' | ')).toEqual([]);
  expect(fake.calls.every((c) => /^(GET|POST|PATCH|PUT|DELETE) (api|uploads)\.github\.com\//.test(c))).toBe(true);
});

test('wrong token shows a clear message; missing repo offers to create it privately', async ({ page }) => {
  const fake = new FakeGithub();
  fake.exists = false;
  await mockGithub(page, fake);
  await page.goto('/#/settings');
  await page.getByLabel('Token').fill('bad-token');
  await page.getByLabel(/Repository \(owner\/name\)/).fill('me/fsave-storage');
  await page.getByRole('button', { name: /Test connection/ }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid, revoked or expired/);

  await page.getByLabel('Token').fill(fake.token);
  await page.getByRole('button', { name: /Test connection/ }).click();
  await page.getByRole('button', { name: /Create private repo/ }).click();
  await expect(page.getByText(/Created private repository me\/fsave-storage/)).toBeVisible();
  expect(fake.isPrivate).toBe(true);
});

test('refuses a public repo without typed confirmation', async ({ page }) => {
  const fake = new FakeGithub();
  fake.isPrivate = false;
  await mockGithub(page, fake);
  await page.goto('/#/settings');
  await page.getByLabel('Token').fill(fake.token);
  await page.getByLabel(/Repository \(owner\/name\)/).fill('me/fsave-storage');
  await page.getByRole('button', { name: /Test connection/ }).click();
  await expect(page.getByRole('heading', { name: /This repository is public/ })).toBeVisible();
  const confirm = page.getByRole('button', { name: /I understand/ });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Type repository name to confirm').fill('me/fsave-storage');
  await expect(confirm).toBeEnabled();
});
