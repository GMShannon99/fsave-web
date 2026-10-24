# fsave-web

A static web app (hosted on GitHub Pages) that saves files and folders from your computer into a **private GitHub repository you own**, then lets you browse, retrieve and download them from any device — individual files, or a whole save as a zip.

There is no server. The browser talks directly to the GitHub REST API using a fine-grained personal access token you paste in.

## Contents
- [Setup](#setup) · [Creating the token](#creating-the-token) · [How storage is laid out](#how-storage-is-laid-out) · [Limits](#limits)
- [Security notes](#security-notes) · [Deleting and purging history](#deleting-and-purging-history) · [Walkthrough](#walkthrough) · [Development](#development)

## Setup

1. **Create the storage repo** (private). On GitHub: *New repository* → name it e.g. `fsave-storage` → **Private**. (Or let the app create it for you on first run — see below.)
2. **Push this project** to a GitHub repo (the *app* repo — can be public or private; it contains no data). Use the `main` branch.
3. **Enable GitHub Pages:** app repo → *Settings* → *Pages* → *Build and deployment* → **Source: GitHub Actions**. (Private app repos need a plan that supports Pages for private repos.)
4. Push to `main`. `.github/workflows/deploy.yml` runs the unit tests, builds with `VITE_BASE=/<repo-name>/` and deploys. Your site appears at `https://<you>.github.io/<repo-name>/`.
5. Open the site, paste your token and the storage repo name, and click **Test connection & save**.

If the storage repo doesn't exist, *Test connection* offers to create it as private (needs a token allowed to create repositories). A **public** repo is refused unless you type its full name to confirm.

## Creating the token

Use a **fine-grained** token limited to the storage repo only:

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. **Token name:** `fsave-web`. **Expiration:** pick something sensible (e.g. 90 days).
3. **Repository access → Only select repositories** → choose your storage repo (only that one).
4. **Repository permissions → Contents → Read and write.** This also covers releases and the Git Data API. *Metadata: Read* is added automatically. Nothing else is needed.
5. **Generate token**, copy it (`github_pat_…`) and paste it in fsave-web's Settings.

Fine-grained tokens can't target a repository that doesn't exist yet, so create the repo first and then the token. To have the app create the repo, you need a token that can create repositories (a classic token with `repo` scope works) — afterwards, switch to a narrowly scoped one.

By default the token lives in `sessionStorage` (gone when the tab closes). Ticking **Remember on this device** stores it in `localStorage`; do that only on a computer you trust.

## How storage is laid out

```
index.json                      list of all saves (name, tags, date, counts, sample of file names)
saves/<save-id>/manifest.json   full metadata + every file's path, size, SHA-256, storage location
saves/<save-id>/files/...       the files, original folder structure preserved (files < 50 MB)
release  tag  save-<save-id>    release assets for files between 50 MB and 2 GB
```

`<save-id>` looks like `20250131-235959-ab12` (UTC time + random suffix, so it sorts by date).

- Each save is **one commit** made through the Git Data API (blobs → tree → commit → ref update). `index.json` is updated in the same commit. If the branch moved meanwhile, the save is rebased onto the new head and retried once.
- Identical content is **never uploaded twice**: the app checks existing blob SHAs in the repo and reuses them.
- If a save fails or is cancelled, nothing is committed and any release created for it is deleted. (Blobs already uploaded become unreachable and are garbage-collected by GitHub.)

## Limits

| Item | Limit |
|---|---|
| Per file, stored in git | up to 50 MB |
| Per file, stored as release asset | 50 MB – 2 GB |
| Per file, rejected | over 2 GB |
| Paths inside a `.git` folder | can't be stored (git refuses them) — excluded automatically |
| Zip download | warns above ~1 GB — the zip is built **in memory** in your browser |
| Search by file name | covers the first 300 file names of each save (the rest are still in the save) |

Practical notes: files near 50 MB are base64-encoded for upload (~67 MB request). Files above ~256 MB are hashed in chunks with a built-in JS SHA-256 instead of SubtleCrypto (which needs the whole file in memory). Downloading a multi-GB release asset also needs that much browser memory. GitHub repos have soft size guidelines (~1–5 GB); release assets are the better place for big data.

## Security notes

- The token is sent **only** to `api.github.com` and `uploads.github.com`. It is never logged, never put in a URL, and never included in error messages. Share links contain only the save id and repo name.
- Release-asset downloads are redirected by GitHub to its own signed `*.githubusercontent.com` URL; the browser doesn't forward your token there. That domain is allowed in the CSP for this reason.
- A strict Content-Security-Policy meta tag (`default-src 'none'`, scripts/styles/workers from `'self'` only, `connect-src` limited to GitHub) is injected at build time. No analytics, fonts, or CDNs.
- Anything that can run script on the site's origin can read a `localStorage` token. Use a fine-grained, single-repo, short-lived token, and keep "remember" off on shared machines.
- Keep the storage repo **private**. Files are stored unencrypted; GitHub (and anyone with repo access) can read them.
- Downloaded files are checked against the recorded SHA-256; mismatches are flagged and listed in `FSAVE-VERIFICATION-FAILED.txt` inside zips.
- **Share links** (`#/save/<id>?repo=owner/name`) don't grant access: the viewer needs their own token with access to the repo.

## Deleting and purging history

*Delete* (typed confirmation) removes the save's folder and release in one commit. **Git history still contains the files** — anyone with repo access can recover them from earlier commits. To truly purge:

```bash
git clone --mirror https://github.com/<you>/fsave-storage.git && cd fsave-storage.git
pip install git-filter-repo
git filter-repo --path saves/<save-id> --invert-paths
git push --force --mirror
```

Then ask GitHub Support to run garbage collection if you need cached objects gone, or simply delete and recreate the repository (copying out what you want to keep). Release assets are removed by Delete itself.

## Walkthrough

**Save a folder.** Open the app → **New save** → *Pick folder* (or drag a folder in). Review the tree: `.git/`, `node_modules/`, `.DS_Store`, `Thumbs.db` are unchecked by default; edit exclude patterns or uncheck anything else. Name it, add tags/note, click **Save**. Progress bars show hashing, upload and the commit; a summary lists what was uploaded vs. reused.

**Find it on another computer.** Open the site there, paste a token for the same repo (create one as above) and the repo name, then **Saves**. Search by name, tag or file name; sort by date or size.

**Download as a zip.** Open the save → **Download all (zip)** (or tick files/folders → **Download selected**). Each file is verified against its SHA-256 as it is fetched. Single files have their own **Download** button.

## Development

```bash
npm install
npm run dev          # local dev server (real GitHub API)
npm test             # Vitest unit/integration tests (MSW-mocked GitHub API)
npm run e2e          # Playwright save -> browse -> download flow against a mocked API (builds first)
npm run build        # type-check + production bundle in dist/
```

Layout: `src/api/github.ts` (REST client, errors, rate limiting) · `src/storage/` (manifest, excludes, paths, hashing, commit builder, save/delete, zip) · `src/ui/` (Preact screens) · `src/workers/hash.ts` (hashing worker) · `tests/support/fakeGithub.ts` (in-memory GitHub used by both test suites) · `oauth-worker/` (optional).

Browsers: current Chrome, Edge, Firefox, Safari. Folder picking uses `<input webkitdirectory>` and is hidden on phones/tablets (drag-and-drop of folders also works on desktop).
