// Optional Cloudflare Worker: exchanges a GitHub OAuth `code` for an access token, because GitHub's
// token endpoint has no browser CORS and needs the client secret. See README.md in this folder.
//
// Secrets/vars (wrangler): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (secret), ALLOWED_ORIGIN (e.g. https://you.github.io)

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

    let code;
    try {
      ({ code } = await request.json());
    } catch {
      return new Response('Bad request', { status: 400, headers: cors });
    }
    if (typeof code !== 'string' || !code) return new Response('Missing code', { status: 400, headers: cors });

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
    });
    const data = await res.json();
    // Return only the token (or the error); never echo the client secret.
    return new Response(JSON.stringify(data.access_token ? { access_token: data.access_token } : { error: data.error ?? 'exchange_failed' }), {
      status: data.access_token ? 200 : 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
