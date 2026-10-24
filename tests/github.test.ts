import { describe, expect, it } from 'vitest';
import { GitHubClient, errorFromResponse } from '../src/api/github';
import { mountFake } from './support/harness';

const hdr = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()] ?? null;

describe('error mapping', () => {
  it('maps statuses to kinds with actionable messages', () => {
    expect(errorFromResponse(401, hdr({}), '{"message":"Bad credentials"}')).toMatchObject({ kind: 'auth' });
    expect(errorFromResponse(403, hdr({}), '{"message":"Resource not accessible by personal access token"}')).toMatchObject({ kind: 'permission' });
    expect(errorFromResponse(404, hdr({}), '')).toMatchObject({ kind: 'not-found' });
    expect(errorFromResponse(409, hdr({}), '{"message":"Git Repository is empty."}')).toMatchObject({ kind: 'empty-repo' });
    expect(errorFromResponse(422, hdr({}), '{"message":"Update is not a fast forward"}')).toMatchObject({ kind: 'conflict' });
    expect(errorFromResponse(503, hdr({}), '')).toMatchObject({ kind: 'server' });
  });
  it('reports the reset time for rate limits', () => {
    const now = 1_700_000_000_000;
    const e = errorFromResponse(403, hdr({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), '{"message":"API rate limit exceeded"}', now);
    expect(e.kind).toBe('rate-limit');
    expect(e.resetAt!.getTime()).toBe(now + 600_000);
    expect(e.message).toMatch(/resets at/);
  });
});

describe('client', () => {
  it('backs off on a short rate limit and then succeeds', async () => {
    const { fake, client, sleeps } = mountFake();
    fake.rateLimitOnce = { retryAfter: 2 };
    expect((await client.getRepo()).private).toBe(true);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1000);
  });
  it('surfaces a long rate limit instead of waiting', async () => {
    const { fake, client } = mountFake();
    fake.rateLimitOnce = { retryAfter: 3600 };
    await expect(client.getRepo()).rejects.toMatchObject({ kind: 'rate-limit' });
  });
  it('reports a bad token without leaking it', async () => {
    const { fake } = mountFake();
    const bad = new GitHubClient({ token: 'ghp_SECRET', owner: fake.owner, repo: fake.repo });
    const err = await bad.getRepo().catch((e) => e);
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('SECRET');
  });
  it('reports a missing repo', async () => {
    const { fake } = mountFake();
    const c = new GitHubClient({ token: fake.token, owner: 'me', repo: 'nope' });
    await expect(c.getRepo()).rejects.toMatchObject({ kind: 'not-found' });
  });
  it('reads the rate limit', async () => {
    const { client } = mountFake();
    expect((await client.getRateLimit()).remaining).toBe(4990);
  });
});
