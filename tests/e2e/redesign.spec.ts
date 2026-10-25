import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGithub } from '../support/fakeGithub';
import { BASE, mock, seedSignedIn } from '../support/oauthMock';

// Runs against the build with sign-in enabled (port 4174), starting already signed in.
test.use({ baseURL: BASE });

function twoFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'fsave-e2e-'));
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'notes.txt');
  const b = join(dir, 'photo.jpg');
  writeFileSync(a, 'my notes');
  writeFileSync(b, Buffer.from([1, 2, 3, 4]));
  return [a, b];
}

test('welcome screen shows only the sign-in button and a short note', async ({ page }) => {
  await mock(page, new FakeGithub());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'fsave-web' })).toBeVisible();
  await expect(page.getByText('Save files to your private cloud and get them back from any computer.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect(page.getByText(/GMShannon99\)\. On a new computer GitHub may email you a code — check your spam folder/)).toBeVisible();
  // Nothing else: no menu, no token box, no technical words.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByLabel('Token')).toHaveCount(0);
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const w of ['token', 'repo', 'commit', 'sha', 'manifest']) expect(text).not.toMatch(new RegExp(`\\b${w}`));
  await page.screenshot({ path: 'screenshots/8-welcome.png', fullPage: true });
});

test('upload from the home screen in three steps, then download and delete from the list', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake);
  await seedSignedIn(page, fake);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/#/');
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();
  await expect(page.getByText('Click Upload files to save your first files.')).toBeVisible();
  await expect(page.getByText('Upload files', { exact: true }).first()).toBeVisible();

  // Choosing files on the home screen goes straight to the upload steps.
  await page.getByTestId('home-pick-files').setInputFiles(twoFiles());
  await expect(page.getByRole('heading', { name: '1. Choose files' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '2. Name it' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '3. Upload' })).toBeVisible();
  await expect(page.getByText('2 files selected')).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue(/^2 files - [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  const upload = page.getByRole('button', { name: /Upload 2 files/ });
  await expect(upload).toBeInViewport(); // no scrolling needed
  await page.getByLabel('Name').fill('test');
  await page.screenshot({ path: 'screenshots/9-upload-steps.png', fullPage: true });
  await upload.click();

  await expect(page.getByRole('heading', { name: "✓ Uploaded 2 files to 'test'" })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to my files' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload more' })).toBeVisible();
  await page.getByRole('button', { name: 'Upload more' }).click();
  await expect(page.getByRole('heading', { name: '1. Choose files' })).toBeVisible();

  // The new save is in the list at once, with its own Download button.
  await page.getByRole('link', { name: 'My files' }).click();
  await expect(page.getByRole('heading', { name: 'test' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download test' })).toBeVisible();
  await expect(page.getByText(/2 files/)).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download test' }).click();
  await dl;
  await expect(page.getByText('✓ Downloading — check your Downloads folder.')).toBeVisible();

  // Delete: plain explanation + typed confirmation; the list updates immediately.
  await page.getByRole('link', { name: 'test' }).click();
  await expect(page.getByRole('button', { name: 'Download all' })).toBeVisible();
  await page.getByText('More options').click();
  await page.getByRole('button', { name: /Delete this save/ }).click();
  await expect(page.getByText('The original files on your computer are not affected.')).toBeVisible();
  const del = page.getByRole('button', { name: 'Delete permanently' });
  await expect(del).toBeDisabled();
  await page.getByLabel(/To confirm, type/).fill('test');
  await del.click();
  await expect(page.getByText('✓ Deleted “test”.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'test' })).toHaveCount(0);
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the list is not fooled by an old copy of the index', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake);
  await seedSignedIn(page, fake);
  const staleHead = fake.head;
  await page.goto('/#/');
  await page.getByTestId('home-pick-files').setInputFiles(twoFiles());
  await page.getByLabel('Name').fill('first');
  await page.getByRole('button', { name: /Upload 2 files/ }).click();
  await expect(page.getByRole('heading', { name: /Uploaded 2 files/ })).toBeVisible();

  // From now on GitHub keeps answering "the branch is still at the old commit" (a stale cached reply).
  await page.route(/api\.github\.com\/repos\/me\/fsave-storage\/git\/ref\/heads\/main$/, (route) =>
    route.request().method() !== 'GET' ? route.fallback() : route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ object: { sha: staleHead } }) }),
  );
  await page.getByRole('link', { name: 'Back to my files' }).click();
  await expect(page.getByRole('heading', { name: 'first' })).toBeVisible(); // still listed

  // And a delete stays deleted even if the old list comes back.
  await page.getByRole('link', { name: 'first' }).click();
  await page.unroute(/api\.github\.com\/repos\/me\/fsave-storage\/git\/ref\/heads\/main$/);
  await page.getByText('More options').click();
  await page.getByRole('button', { name: /Delete this save/ }).click();
  await page.getByLabel(/To confirm, type/).fill('first');
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();
});

test('help page explains the basics in plain words', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake);
  await seedSignedIn(page, fake);
  await page.goto('/#/');
  await page.getByRole('link', { name: 'Help' }).click();
  for (const h of ['Upload files', 'Download files', 'Delete a save', 'Using a new computer']) {
    await expect(page.getByRole('heading', { name: h })).toBeVisible();
  }
  await expect(page.getByText('Deleting here never deletes the original files on your computer.')).toBeVisible();
  await expect(page.getByText(/spam/).first()).toBeVisible();
  await expect(page.getByText(/recovery codes/)).toBeVisible();
});

test('settings: sign out is easy to find; technical settings are at the very bottom', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake);
  await seedSignedIn(page, fake);
  await page.goto('/#/settings');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByLabel('Token')).toBeHidden();
  const advanced = page.getByText('Advanced (for troubleshooting)');
  const signOut = page.getByRole('button', { name: 'Sign out' });
  expect((await advanced.boundingBox())!.y).toBeGreaterThan((await signOut.boundingBox())!.y);
  await signOut.click();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});
