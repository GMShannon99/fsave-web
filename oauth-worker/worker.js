// Cloudflare Worker for "Sign in with GitHub" (GitHub App user authorization).
// GitHub's token endpoint has no browser CORS and needs the client secret, so the browser asks this
// worker to do the exchange. See README.md in this folder.
//
//   POST /token    { "code": "<code from GitHub>" }          -> { access_token, expires_in, refresh_token, refresh_token_expires_in }
//   POST /refresh  { "refresh_token": "<refresh token>" }    -> same shape
//
// Vars/secrets (wrangler): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (secret), ALLOWED_ORIGIN (e.g. https://you.github.io)

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' || origin !== env.ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    const isRefresh = path.endsWith('/refresh');

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request', { status: 400, headers: cors });
    }
    const field = isRefresh ? body?.refresh_token : body?.code;
    if (typeof field !== 'string' || !field) return new Response(isRefresh ? 'Missing refresh_token' : 'Missing code', { status: 400, headers: cors });

    const params = isRefresh
      ? { grant_type: 'refresh_token', refresh_token: field }
      : { code: field };
    let data;
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
      });
      data = await res.json();
    } catch {
      return json({ error: 'upstream_unreachable' }, 502, cors);
    }
    // Return only token fields (or the error code); never echo the client secret or GitHub's raw reply.
    if (!data?.access_token) return json({ error: data?.error ?? 'exchange_failed' }, 400, cors);
    const out = { access_token: data.access_token };
    for (const k of ['expires_in', 'refresh_token', 'refresh_token_expires_in']) if (data[k] !== undefined) out[k] = data[k];
    return json(out, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
