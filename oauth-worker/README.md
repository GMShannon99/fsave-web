# "Sign in with GitHub" worker

Lets fsave-web offer a **Sign in with GitHub** button instead of pasting a token. It is optional: without it the app falls back to the pasted-token form (Settings → Advanced).

## Why a worker, and why a GitHub App
- GitHub Pages can't keep a secret, and GitHub's token endpoint can't be called from a browser. This tiny Cloudflare Worker holds the **client secret** and swaps GitHub's one-time `code` for tokens.
- fsave-web uses a **GitHub App** (not an OAuth App). A GitHub App can only reach the repositories you select when you install it — just the storage repo — whereas an OAuth App's `repo` scope reaches *all* your repos.
- GitHub App user tokens **expire after 8 hours** and come with a refresh token (valid ~6 months). The app refreshes them quietly through this worker. If the refresh token expires or is revoked, the sign-in button comes back.
- The worker never stores anything and only answers requests whose `Origin` is your Pages site.

## API
| Request | Body | Reply |
|---|---|---|
| `POST /token` | `{ "code": "…" }` | `{ access_token, expires_in, refresh_token, refresh_token_expires_in }` |
| `POST /refresh` | `{ "refresh_token": "…" }` | same |

Errors come back as `{ "error": "<code>" }`. The client secret is never returned.

## One-time setup (about 20 minutes)

### Part 1 — Register the GitHub App
1. Sign in at <https://github.com>. Click your **profile picture** (top right) → **Settings**.
2. Scroll the left menu to the bottom → **Developer settings** → **GitHub Apps** → **New GitHub App**.
3. Fill in:
   - **GitHub App name:** something unique, e.g. `fsave-web-gmshannon99`. (If taken, add digits. The name becomes the "slug" in the app's URL — note it.)
   - **Homepage URL:** `https://gmshannon99.github.io/fsave-web/`
   - **Callback URL:** `https://gmshannon99.github.io/fsave-web/`
   - **Expire user authorization tokens:** leave **ticked**.
   - **Request user authorization (OAuth) during installation:** leave **unticked**.
   - **Setup URL:** `https://gmshannon99.github.io/fsave-web/` and tick **Redirect on update**.
   - **Webhook → Active:** **untick** it.
4. **Repository permissions → Contents → Read and write.** (Leave everything else at "No access"; *Metadata: Read* is added automatically.)
5. **Where can this GitHub App be installed?** → **Only on this account**.
6. Click **Create GitHub App**.
7. On the app's page, copy the **Client ID** (starts with `Iv`) and the app's **slug** (the last part of the page's URL, `github.com/apps/<slug>`).
8. Scroll to **Client secrets** → **Generate a new client secret**. **Copy it now** — GitHub shows it only once. Keep it private (never paste it into chat, code or the website).

### Part 2 — Install the App on the storage repo only
1. On the app's page, in the left menu click **Install App** → **Install** next to your account.
2. Choose **Only select repositories** → pick `fsave-storage` → **Install**.

### Part 3 — Cloudflare Worker
1. Create a free account at <https://dash.cloudflare.com/sign-up> and verify your email. (No card needed for Workers' free plan.)
2. Install [Node.js](https://nodejs.org) (LTS) if you don't have it.
3. In a terminal, in this `oauth-worker` folder:
   ```
   npx wrangler login
   ```
   A browser tab opens → **Allow**.
4. Copy `wrangler.toml.example` to `wrangler.toml` and put your Client ID in it.
5. Store the secret (you'll be prompted to paste it; nothing is echoed):
   ```
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
6. Deploy:
   ```
   npx wrangler deploy
   ```
   The first time, it asks you to pick a free `workers.dev` name. It then prints the worker URL, e.g. `https://fsave-oauth.<name>.workers.dev`.

### Part 4 — Tell the website about it
In the **fsave-web** repo on GitHub: **Settings → Secrets and variables → Actions → Variables** tab → **New repository variable**, three times (these are public values, not secrets):

| Name | Value |
|---|---|
| `VITE_GITHUB_CLIENT_ID` | the Client ID |
| `VITE_GITHUB_APP_SLUG` | the app slug |
| `VITE_OAUTH_WORKER_URL` | the worker URL (no trailing slash) |

Then **Actions → Deploy to GitHub Pages → Run workflow** (or push to `main`). The site now shows **Sign in with GitHub**.

## Local testing
`npm test` covers the worker with a mocked GitHub. `npm run e2e` also drives the full sign-in redirect against a mocked worker.
