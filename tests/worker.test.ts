import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (the Cloudflare Worker), no type declarations
import worker from '../oauth-worker/worker.js';
import { server } from './support/setup';

const env = { GITHUB_CLIENT_ID: 'Iv1.id', GITHUB_CLIENT_SECRET: 'sekret', ALLOWED_ORIGIN: 'https://me.github.io' };
const req = (path: string, body: unknown, origin: string | null = env.ALLOWED_ORIGIN, method = 'POST') =>
  new Request(`https://w.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

function mockGithub(reply: Record<string, unknown>) {
  const seen: unknown[] = [];
  server.use(
    http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
      seen.push(await request.json());
      return HttpResponse.json(reply);
    }),
  );
  return seen;
}

describe('oauth worker', () => {
  it('exchanges a code and returns only the token fields', async () => {
    const seen = mockGithub({ access_token: 'at', expires_in: 28800, refresh_token: 'rt', refresh_token_expires_in: 100, scope: '', token_type: 'bearer', extra: 'x' });
    const res: Response = await worker.fetch(req('/token', { code: 'C' }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: 'at', expires_in: 28800, refresh_token: 'rt', refresh_token_expires_in: 100 });
    expect(seen[0]).toEqual({ client_id: 'Iv1.id', client_secret: 'sekret', code: 'C' });
    expect(res.headers.get('access-control-allow-origin')).toBe(env.ALLOWED_ORIGIN);
  });

  it('refreshes with grant_type=refresh_token', async () => {
    const seen = mockGithub({ access_token: 'at2', expires_in: 1, refresh_token: 'rt2' });
    const res: Response = await worker.fetch(req('/refresh', { refresh_token: 'rt1' }), env);
    expect(await res.json()).toMatchObject({ access_token: 'at2', refresh_token: 'rt2' });
    expect(seen[0]).toEqual({ client_id: 'Iv1.id', client_secret: 'sekret', grant_type: 'refresh_token', refresh_token: 'rt1' });
  });

  it('passes GitHub errors on as a bare error code (never the secret)', async () => {
    mockGithub({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
    const res: Response = await worker.fetch(req('/refresh', { refresh_token: 'x' }), env);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'bad_refresh_token' });
    expect(text).not.toContain('sekret');
  });

  it('rejects other origins, missing origin and non-POST without calling GitHub', async () => {
    const seen = mockGithub({ access_token: 'x' });
    expect((await worker.fetch(req('/token', { code: 'C' }, 'https://evil.example'), env)).status).toBe(403);
    expect((await worker.fetch(req('/token', { code: 'C' }, null), env)).status).toBe(403);
    expect((await worker.fetch(req('/token', {}, env.ALLOWED_ORIGIN, 'GET'), env)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('answers CORS preflight and validates input', async () => {
    const pre: Response = await worker.fetch(new Request('https://w.example/token', { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN } }), env);
    expect(pre.status).toBe(204);
    expect((await worker.fetch(req('/token', {}), env)).status).toBe(400);
    expect((await worker.fetch(req('/refresh', { code: 'C' }), env)).status).toBe(400);
    const bad = new Request('https://w.example/token', { method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN }, body: 'not json' });
    expect((await worker.fetch(bad, env)).status).toBe(400);
  });

  it('returns 502 when GitHub is unreachable', async () => {
    server.use(http.post('https://github.com/login/oauth/access_token', () => HttpResponse.error()));
    expect((await worker.fetch(req('/token', { code: 'C' }), env)).status).toBe(502);
  });
});
