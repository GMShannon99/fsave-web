import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/api/github';
import { connectStorage } from '../src/auth/connect';
import { AuthManager, SESSION_KEY, authorizeUrl, parseCallback, rememberState, type KV, type Session } from '../src/auth/session';
import { FakeGithub } from './support/fakeGithub';
import { mountFake } from './support/harness';

class MemKV implements KV {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

const HOUR = 3600_000;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** A stand-in for the worker: records calls, answers from a queue. */
function stubWorker(...replies: Array<Response | Error>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const r = replies.shift();
    if (!r) throw new Error('unexpected worker call');
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function mgr(opts: { replies?: Array<Response | Error>; session?: Session; now?: { t: number } } = {}) {
  const storage = new MemKV();
  if (opts.session) storage.setItem(SESSION_KEY, JSON.stringify(opts.session));
  const w = stubWorker(...(opts.replies ?? []));
  const events: Array<[Session | null, boolean]> = [];
  const now = opts.now ?? { t: 1_000_000 };
  const auth = new AuthManager({ workerUrl: 'https://w.example', storage, fetchImpl: w.fetchImpl, now: () => now.t, onChange: (s, e) => events.push([s, e]) });
  return { auth, storage, events, now, ...w };
}

const live = (extra: Partial<Session> = {}): Session => ({ accessToken: 'at1', expiresAt: 1_000_000 + 8 * HOUR, refreshToken: 'rt1', refreshExpiresAt: 1_000_000 + 100 * HOUR, ...extra });

describe('AuthManager', () => {
  it('exchanges a code, stores the session and computes expiry', async () => {
    const { auth, storage, calls } = mgr({ replies: [json(200, { access_token: 'at1', expires_in: 28800, refresh_token: 'rt1', refresh_token_expires_in: 15811200 })] });
    const s = await auth.exchangeCode('abc');
    expect(calls[0]).toEqual({ url: 'https://w.example/token', body: { code: 'abc' } });
    expect(s).toMatchObject({ accessToken: 'at1', expiresAt: 1_000_000 + 28_800_000, refreshToken: 'rt1' });
    expect(JSON.parse(storage.getItem(SESSION_KEY)!).accessToken).toBe('at1');
  });

  it('reports a failed code exchange without storing anything', async () => {
    const { auth, storage } = mgr({ replies: [json(400, { error: 'bad_verification_code' })] });
    await expect(auth.exchangeCode('x')).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('bad_verification_code') });
    expect(storage.getItem(SESSION_KEY)).toBeNull();
  });

  it('returns the current token without calling the worker while it is fresh', async () => {
    const { auth, calls } = mgr({ session: live() });
    expect(await auth.getToken()).toBe('at1');
    expect(calls).toHaveLength(0);
  });

  it('never refreshes a non-expiring token unless forced', async () => {
    const { auth, calls } = mgr({ session: { accessToken: 'forever', expiresAt: null } });
    expect(await auth.getToken()).toBe('forever');
    expect(calls).toHaveLength(0);
  });

  it('refreshes automatically before expiry and stores the rotated refresh token', async () => {
    const { auth, calls, storage, now } = mgr({
      session: live(),
      replies: [json(200, { access_token: 'at2', expires_in: 28800, refresh_token: 'rt2', refresh_token_expires_in: 15811200 })],
    });
    now.t += 8 * HOUR - 60_000; // one minute left
    expect(await auth.getToken()).toBe('at2');
    expect(calls).toEqual([{ url: 'https://w.example/refresh', body: { refresh_token: 'rt1' } }]);
    expect(JSON.parse(storage.getItem(SESSION_KEY)!)).toMatchObject({ accessToken: 'at2', refreshToken: 'rt2' });
  });

  it('shares one refresh between concurrent callers', async () => {
    const { auth, calls, now } = mgr({ session: live(), replies: [json(200, { access_token: 'at2', expires_in: 28800, refresh_token: 'rt2' })] });
    now.t += 9 * HOUR;
    const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    expect(tokens).toEqual(['at2', 'at2', 'at2']);
    expect(calls).toHaveLength(1);
  });

  it('signs out and flags "expired" when the refresh token is rejected', async () => {
    const { auth, storage, events, now } = mgr({ session: live(), replies: [json(400, { error: 'bad_refresh_token' })] });
    now.t += 9 * HOUR;
    await expect(auth.getToken()).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/sign in again/i) });
    expect(auth.session).toBeNull();
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(events.at(-1)).toEqual([null, true]);
  });

  it('signs out without calling the worker when the refresh token itself has expired', async () => {
    const { auth, calls, now } = mgr({ session: live({ refreshExpiresAt: 2_000_000 }) });
    now.t += 9 * HOUR;
    await expect(auth.getToken()).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(0);
  });

  it('keeps the session through a worker outage or network failure', async () => {
    const { auth, now } = mgr({ session: live(), replies: [json(502, { error: 'upstream_unreachable' }), new TypeError('offline')] });
    now.t += 9 * HOUR;
    await expect(auth.getToken()).rejects.toMatchObject({ kind: 'network' });
    await expect(auth.getToken()).rejects.toMatchObject({ kind: 'network' });
    expect(auth.session).not.toBeNull();
  });

  it('adopts a session another tab already refreshed instead of signing out', async () => {
    const { auth, storage, now } = mgr({ session: live(), replies: [json(400, { error: 'bad_refresh_token' })] });
    now.t += 9 * HOUR;
    storage.setItem(SESSION_KEY, JSON.stringify({ accessToken: 'at-other-tab', expiresAt: now.t + 8 * HOUR, refreshToken: 'rt-other' }));
    expect(await auth.getToken()).toBe('at-other-tab');
  });

  it('signOut clears storage', async () => {
    const { auth, storage } = mgr({ session: live() });
    auth.signOut();
    expect(auth.session).toBeNull();
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    await expect(auth.getToken()).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('redirect handling', () => {
  it('accepts a code only with the matching state, once', () => {
    const kv = new MemKV();
    rememberState(kv, 'st8');
    expect(parseCallback('?code=C1&state=st8', kv)).toEqual({ kind: 'code', code: 'C1' });
    expect(parseCallback('?code=C1&state=st8', kv)).toMatchObject({ kind: 'error' }); // state is single-use
  });
  it('rejects a wrong or missing state', () => {
    const kv = new MemKV();
    rememberState(kv, 'good');
    expect(parseCallback('?code=C1&state=evil', kv)).toMatchObject({ kind: 'error' });
    expect(parseCallback('?code=C1', new MemKV())).toMatchObject({ kind: 'error' });
  });
  it('ignores URLs that are not a sign-in redirect and reports a cancelled one', () => {
    expect(parseCallback('', new MemKV())).toEqual({ kind: 'none' });
    expect(parseCallback('?installation_id=5&setup_action=install', new MemKV())).toEqual({ kind: 'none' });
    const kv = new MemKV();
    rememberState(kv, 's');
    expect(parseCallback('?error=access_denied&state=s', kv)).toMatchObject({ kind: 'error' });
  });
  it('builds an authorize URL with no scope (GitHub App)', () => {
    const u = new URL(authorizeUrl('Iv1.abc', 's'));
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('Iv1.abc');
    expect(u.searchParams.has('scope')).toBe(false);
  });
});

describe('client with a token provider', () => {
  it('asks for a fresh token and retries once after a 401', async () => {
    const { fake } = mountFake();
    const asked: boolean[] = [];
    const client = new GitHubClient({
      owner: fake.owner,
      repo: fake.repo,
      getToken: async (force) => {
        asked.push(!!force);
        return force ? fake.token : 'stale';
      },
    });
    expect((await client.getRepo()).full_name).toBe('me/fsave-storage');
    expect(asked).toEqual([false, true]);
  });
  it('gives up (does not loop) when the refreshed token is also rejected', async () => {
    const { fake } = mountFake();
    const client = new GitHubClient({ owner: fake.owner, repo: fake.repo, getToken: async () => 'always-bad' });
    await expect(client.getRepo()).rejects.toMatchObject({ kind: 'auth' });
  });
  it('propagates a sign-in-expired error from the provider', async () => {
    const { fake } = mountFake();
    const { auth } = mgr({ session: live({ accessToken: 'stale' }), replies: [json(400, { error: 'bad_refresh_token' })] });
    const client = new GitHubClient({ owner: fake.owner, repo: fake.repo, getToken: (f) => auth.getToken(f) });
    await expect(client.getRepo()).rejects.toMatchObject({ kind: 'auth' }); // 401 -> forced refresh -> rejected
    expect(auth.session).toBeNull();
  });
});

describe('connectStorage', () => {
  const getToken = (fake: FakeGithub) => async () => fake.token;

  it('connects to an existing private repo', async () => {
    const { fake } = mountFake();
    const r = await connectStorage({ getToken: getToken(fake), repo: { owner: 'me', repo: 'fsave-storage' } });
    expect(r).toMatchObject({ status: 'connected', info: { full_name: 'me/fsave-storage', default_branch: 'main' } });
  });
  it('defaults to <login>/fsave-storage when no repo is configured', async () => {
    const { fake } = mountFake();
    const r = await connectStorage({ getToken: getToken(fake) });
    expect(r).toMatchObject({ status: 'connected', info: { full_name: 'me/fsave-storage' } });
  });
  it('adds an initial README to a completely empty repo', async () => {
    const { fake } = mountFake(new FakeGithub({ empty: true }));
    expect(fake.head).toBe('');
    await connectStorage({ getToken: getToken(fake) });
    expect(fake.head).not.toBe('');
  });
  it('asks for the app to be installed when the repo is not visible', async () => {
    const fake = new FakeGithub();
    fake.exists = false;
    mountFake(fake);
    expect(await connectStorage({ getToken: getToken(fake) })).toEqual({ status: 'needs-install', repo: 'me/fsave-storage' });
  });
  it('refuses a public repo unless it was confirmed', async () => {
    const fake = new FakeGithub();
    fake.isPrivate = false;
    mountFake(fake);
    expect((await connectStorage({ getToken: getToken(fake) })).status).toBe('public');
    expect((await connectStorage({ getToken: getToken(fake), publicConfirmed: 'me/fsave-storage' })).status).toBe('connected');
  });
});
