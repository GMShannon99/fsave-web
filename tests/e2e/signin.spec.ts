import { expect, test, type Page } from '@playwright/test';
import { FakeGithub } from '../support/fakeGithub';

// Runs against the build that has the sign-in settings enabled (second webServer, port 4174).
const BASE = 'http://localhost:4174';
const WORKER = 'https://fsave-oauth.test.workers.dev';
test.use({ baseURL: BASE });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept, content-type, x-github-api-version',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after',
};

async function mock(page: Page, fake: FakeGithub, worker: { refresh: 'ok' | 'rejected' } = { refresh: 'ok' }) {
  await page.route(/^https:\/\/(api|uploads)\.github\.com\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const r = fake.handle({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postDataBuffer() });
    await route.fulfill({ status: r.status, headers: { ...r.headers, ...CORS }, body: r.body === null ? undefined : r.body });
  });
  // GitHub's authorize page: approve immediately and redirect back with a code.
  await page.route('https://github.com/login/oauth/authorize**', (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')!;
    return route.fulfill({ status: 302, headers: { location: `${BASE}/?code=the-code&state=${state}` } });
  });
  await page.route(`${WORKER}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (path === '/token') return json(200, { access_token: fake.token, expires_in: 28800, refresh_token: 'rt1', refresh_token_expires_in: 15811200 });
    if (worker.refresh === 'rejected') return json(400, { error: 'bad_refresh_token' });
    fake.token = 'refreshed-token';
    return json(200, { access_token: fake.token, expires_in: 28800, refresh_token: 'rt2', refresh_token_expires_in: 15811200 });
  });
}

test('sign in → connected → use app → sign out; pasted-token option is under Advanced', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect(page.getByLabel('Token')).toBeHidden(); // collapsed under Advanced
  await page.getByText('Advanced: use a pasted access token instead').click();
  await expect(page.getByLabel('Token')).toBeVisible();
  await page.getByText('Advanced: use a pasted access token instead').click();

  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByText(/Signed in\. Connected to/)).toBeVisible();
  await expect(page.getByText('me/fsave-storage').first()).toBeVisible();
  expect(page.url()).not.toContain('code='); // the one-time code is removed from the address bar
  await page.screenshot({ path: 'screenshots/4-signed-in.png', fullPage: true });

  await page.getByRole('link', { name: 'Saves' }).click();
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();
  await page.getByRole('link', { name: 'New save' }).click();
  await expect(page.getByRole('heading', { name: /New save/i })).toBeVisible();

  // Survives a reload without signing in again.
  await page.reload();
  await expect(page.getByRole('heading', { name: /New save/i })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('fsave.session'))).toBeNull();
  expect(errors).toEqual([]);
});

test('an expired session is refreshed silently', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake);
  const soon = Date.now() + 60_000; // inside the refresh window
  await page.addInitScript(
    ([s]) => {
      if (!localStorage.getItem('fsave.session')) {
        localStorage.setItem('fsave.session', JSON.stringify({ accessToken: 'old-token', expiresAt: s, refreshToken: 'rt1', refreshExpiresAt: s + 1e9 }));
        localStorage.setItem('fsave.settings', JSON.stringify({ repo: 'me/fsave-storage', branch: 'main' }));
      }
    },
    [soon],
  );
  await page.goto('/#/');
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();
  const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('fsave.session')))!);
  expect(stored.accessToken).toBe('refreshed-token');
  expect(stored.refreshToken).toBe('rt2');
});

test('when sign-in can no longer be refreshed, the sign-in button comes back', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake, { refresh: 'rejected' });
  const past = Date.now() - 1000;
  await page.addInitScript(
    ([s]) => {
      localStorage.setItem('fsave.session', JSON.stringify({ accessToken: 'old-token', expiresAt: s, refreshToken: 'rt1', refreshExpiresAt: s + 1e9 }));
      localStorage.setItem('fsave.settings', JSON.stringify({ repo: 'me/fsave-storage', branch: 'main' }));
    },
    [past],
  );
  await page.goto('/#/');
  await expect(page.getByText(/sign-in expired/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});

test('signed in but app not installed on the repo: shows the install step', async ({ page }) => {
  const fake = new FakeGithub();
  fake.exists = false;
  await mock(page, fake);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByText(/doesn't have access to/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Choose the storage repository' })).toHaveAttribute('href', 'https://github.com/apps/fsave-test/installations/new');
  fake.exists = true;
  await page.getByRole('button', { name: /check again/ }).click();
  await expect(page.getByText(/Signed in\. Connected to/)).toBeVisible();
});
