import type { Page } from '@playwright/test';
import type { FakeGithub } from './fakeGithub';

// Mocks GitHub's API, its authorize page and the sign-in worker for the build that has sign-in enabled.
export const BASE = 'http://localhost:4174';
export const WORKER = 'https://fsave-oauth.test.workers.dev';

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept, content-type, x-github-api-version',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after',
};

export async function mock(page: Page, fake: FakeGithub, worker: { refresh: 'ok' | 'rejected' } = { refresh: 'ok' }) {
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

/** Starts the page already signed in (as if from an earlier visit), with the storage folder known. */
export async function seedSignedIn(page: Page, fake: FakeGithub) {
  fake.token = 'seeded-token';
  await page.addInitScript(() => {
    if (localStorage.getItem('fsave.session')) return;
    localStorage.setItem('fsave.session', JSON.stringify({ accessToken: 'seeded-token', expiresAt: Date.now() + 8 * 3600_000, refreshToken: 'rt', refreshExpiresAt: Date.now() + 1e10 }));
    localStorage.setItem('fsave.settings', JSON.stringify({ repo: 'me/fsave-storage', branch: 'main' }));
  });
}
