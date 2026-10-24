# Optional: "Sign in with GitHub" worker

**Not required.** fsave-web works with a pasted fine-grained token. This worker exists for people who want a real OAuth sign-in instead. GitHub Pages can't keep a client secret and GitHub's token endpoint has no browser CORS, so a tiny proxy is needed.

> **Status:** the worker (`worker.js`) is provided and documented, but the app's UI does **not** yet have a "Sign in with GitHub" button wired to it. OAuth-app tokens are also coarser than a fine-grained token (the `repo` scope grants access to *all* your repos), which is why the pasted token is the default.

## What it does
`POST { "code": "<oauth code>" }` → exchanges it with GitHub using the secret → returns `{ "access_token": "…" }`. It only answers requests whose `Origin` equals `ALLOWED_ORIGIN`.

## Deploy
1. Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps). Homepage = your Pages URL; callback URL = your Pages URL.
2. `npm i -g wrangler && wrangler login`
3. In this folder create `wrangler.toml`:
   ```toml
   name = "fsave-oauth"
   main = "worker.js"
   compatibility_date = "2024-01-01"
   [vars]
   GITHUB_CLIENT_ID = "<client id>"
   ALLOWED_ORIGIN = "https://<you>.github.io"
   ```
4. `wrangler secret put GITHUB_CLIENT_SECRET`, then `wrangler deploy`.
5. The front end would redirect to `https://github.com/login/oauth/authorize?client_id=…&scope=repo`, then POST the returned `code` to the worker's URL. If you add this, also add the worker URL to `connect-src` in `vite.config.ts`.
