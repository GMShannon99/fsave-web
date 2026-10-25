import { expect, test } from '@playwright/test';
import { FakeGithub } from '../support/fakeGithub';

import { BASE, mock } from '../support/oauthMock';

// Runs against the build that has the sign-in settings enabled (second webServer, port 4174).
test.use({ baseURL: BASE });

test('sign in → straight to my files → sign out; pasted-token option is under Advanced', async ({ page }) => {
  const fake = new FakeGithub();
  await mock(page, fake);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect(page.getByLabel('Token')).toHaveCount(0); // the token form is not on the welcome screen

  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  // Straight to the files, never Settings.
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();
  expect(page.url()).not.toContain('code='); // the one-time code is removed from the address bar
  await page.screenshot({ path: 'screenshots/4-signed-in.png', fullPage: true });

  await page.getByRole('link', { name: 'Upload files' }).click();
  await expect(page.getByRole('heading', { name: 'Upload files' })).toBeVisible();

  // Survives a reload without signing in again.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Upload files' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByLabel('Token')).toBeHidden(); // collapsed under "Advanced"
  await page.getByText('Advanced (for troubleshooting)').click();
  await expect(page.getByLabel('Token')).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
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
  await expect(page.getByText(/sign-in ran out/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});

test('signed in but app not installed on the repo: shows the install step', async ({ page }) => {
  const fake = new FakeGithub();
  fake.exists = false;
  await mock(page, fake);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'One more step' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Allow access to my storage' })).toHaveAttribute('href', 'https://github.com/apps/fsave-test/installations/new');
  fake.exists = true;
  await page.getByRole('button', { name: /I've done this/ }).click();
  await expect(page.getByRole('heading', { name: 'My files' })).toBeVisible();
});
