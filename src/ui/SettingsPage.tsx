import { useState } from 'preact/hooks';
import { GitHubClient, GitHubError, describeError, formatReset, type RateLimit, type RepoInfo } from '../api/github';
import { installUrl } from '../auth/config';
import { parseRepo } from '../storage/config';
import { DEFAULT_EXCLUDES } from '../storage/types';
import { useApp } from './app';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

export function SettingsPage({ firstRun }: { firstRun: boolean }) {
  const app = useApp();
  const [token, setToken] = useState(app.token);
  const [remember, setRemember] = useState(app.remembered);
  const [repo, setRepo] = useState(app.settings.repo);
  const [excludes, setExcludes] = useState(app.settings.excludes.join('\n'));
  const [theme, setTheme] = useState(app.settings.theme);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [rate, setRate] = useState<RateLimit | null>(null);
  const [missingRepo, setMissingRepo] = useState(false);
  const [publicRepo, setPublicRepo] = useState<RepoInfo | null>(null);
  const [typed, setTyped] = useState('');
  const [advOpen, setAdvOpen] = useState(!app.oauth.enabled || !!app.token);

  const parsed = parseRepo(repo);
  const mkClient = () => new GitHubClient({ token: token.trim(), owner: parsed!.owner, repo: parsed!.repo });

  function persist(extra: Partial<typeof app.settings> = {}) {
    app.setToken(token.trim(), remember);
    app.updateSettings({
      repo: repo.trim(),
      theme,
      excludes: excludes.split('\n').map((s) => s.trim()).filter(Boolean),
      ...extra,
    });
  }

  async function test() {
    setMsg(null);
    setMissingRepo(false);
    setPublicRepo(null);
    if (!token.trim() && app.oauth.signedIn) {
      // Signed in with GitHub: just save the form and re-check the storage repo with that sign-in.
      persist();
      await app.recheck();
      return setMsg({ kind: 'ok', text: 'Settings saved.' });
    }
    if (!token.trim()) return setMsg({ kind: 'error', text: 'Paste your fine-grained token first.' });
    if (!parsed) return setMsg({ kind: 'error', text: 'Enter the repository as owner/name, e.g. alice/fsave-storage.' });
    setBusy(true);
    try {
      const c = mkClient();
      const info = await c.getRepo();
      setRate(await c.getRateLimit());
      if (!info.private && app.settings.publicConfirmed !== info.full_name) {
        setPublicRepo(info);
        setMsg({ kind: 'error', text: `${info.full_name} is PUBLIC. Anyone on the internet could read everything you save.` });
        return;
      }
      if (info.permissions && info.permissions.push === false) {
        setMsg({ kind: 'error', text: 'Connected, but the token cannot write to this repo. Give it Contents: Read and write.' });
        return;
      }
      persist({ branch: info.default_branch });
      setMsg({ kind: 'ok', text: `Connected to ${info.full_name} (private, branch ${info.default_branch}). Settings saved.` });
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'not-found') setMissingRepo(true);
      setMsg({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      const c = mkClient();
      const user = await c.getUser();
      if (user.login.toLowerCase() !== parsed!.owner.toLowerCase()) {
        throw new Error(`Repositories can only be created under your own account (${user.login}). Create it on GitHub, or change the owner.`);
      }
      const info = await c.createPrivateRepo(parsed!.repo);
      persist({ branch: info.default_branch });
      setMissingRepo(false);
      setMsg({ kind: 'ok', text: `Created private repository ${info.full_name}. Remember to edit the token so it can access this repo.` });
    } catch (e) {
      setMsg({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  function confirmPublic() {
    persist({ publicConfirmed: publicRepo!.full_name, branch: publicRepo!.default_branch });
    setMsg({ kind: 'ok', text: `Saved. Using the PUBLIC repo ${publicRepo!.full_name} at your own risk.` });
    setPublicRepo(null);
  }

  return (
    <section>
      <h1>{firstRun ? 'Welcome — connect your storage' : 'Settings'}</h1>
      {firstRun && <p>fsave-web stores your files in a <strong>private GitHub repository you own</strong>. Connect one to get started.</p>}

      {app.oauth.enabled && <SignInCard />}

      <form
        class="card"
        onSubmit={(e) => {
          e.preventDefault();
          void test();
        }}
      >
        <h2>Storage repository</h2>
        <label>
          Repository (owner/name)
          <input value={repo} onInput={(e) => setRepo((e.target as HTMLInputElement).value)} placeholder="your-name/fsave-storage" spellcheck={false} />
        </label>

        <h2>Preferences</h2>
        <label>
          Theme
          <select value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value as typeof theme)}>
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label>
          Default exclude patterns (one per line)
          <textarea rows={5} value={excludes} onInput={(e) => setExcludes((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
        </label>
        <button type="button" class="link" onClick={() => setExcludes(DEFAULT_EXCLUDES.join('\n'))}>Reset excludes to defaults</button>

        <details open={advOpen} onToggle={(e) => setAdvOpen((e.target as HTMLDetailsElement).open)}>
          <summary><strong>Advanced: use a pasted access token instead</strong></summary>
        <h2>Access token</h2>
        <details>
          <summary>How to create the token (step by step)</summary>
          <ol>
            <li>
              Open <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">github.com/settings/personal-access-tokens/new</a>.
            </li>
            <li>Name it <code>fsave-web</code> and pick an expiration (90 days is sensible).</li>
            <li>Under <em>Repository access</em> choose <strong>Only select repositories</strong> and pick just your storage repo.</li>
            <li>Under <em>Repository permissions</em> set <strong>Contents → Read and write</strong> (this also covers releases). Metadata: Read is added automatically.</li>
            <li>To let fsave-web <em>create</em> the repo for you, create it on GitHub first instead (fine-grained tokens can't be scoped to a repo that doesn't exist yet).</li>
            <li>Click <strong>Generate token</strong> and paste it below.</li>
          </ol>
        </details>
        <label>
          Token
          <input type="password" autocomplete="off" spellcheck={false} value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} placeholder="github_pat_…" />
        </label>
        <label class="inline">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} />
          Remember on this device
        </label>
        {remember && (
          <p class="warn" role="note">
            ⚠ The token will be kept in this browser's <code>localStorage</code>, readable by anything running on this site. Only do this on a device you own and trust. Leave unchecked to keep it for this tab only.
          </p>
        )}

        </details>

        <div class="actions">
          <button type="submit" class="primary" disabled={busy}>{busy ? 'Working…' : 'Test connection & save'}</button>
          {app.token && (
            <button type="button" onClick={() => { app.setToken('', false); setToken(''); setRemember(false); }}>Forget token</button>
          )}
        </div>
      </form>

      {msg && (
        <p role={msg.kind === 'error' ? 'alert' : 'status'} class={`notice ${msg.kind}`}>
          {msg.text}{' '}
          {msg.kind === 'ok' && <button type="button" class="link" onClick={app.leaveSettings}>Go to my saves →</button>}
        </p>
      )}
      {rate && (
        <p class="muted">API rate limit: {rate.remaining} / {rate.limit} remaining, resets at {formatReset(rate.reset)}.</p>
      )}
      {missingRepo && parsed && (
        <div class="card">
          <p>The repo <code>{repo}</code> wasn't found (or the token can't see it). Either fix the name, or create it now as a <strong>private</strong> repository. Creating requires a token with permission to create repositories (a classic token with <code>repo</code> scope, or a fine-grained token with Administration: write on all repositories).</p>
          <button type="button" class="primary" disabled={busy} onClick={create}>Create private repo {repo}</button>
        </div>
      )}
      {publicRepo && (
        <div class="card danger">
          <h2>⚠ This repository is public</h2>
          <p>Everything you save here would be visible to <strong>anyone</strong>, including search engines. Make the repo private on GitHub (Settings → Danger Zone → Change visibility) instead.</p>
          <p>To use it anyway, type the repo name <code>{publicRepo.full_name}</code> to confirm:</p>
          <input value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} aria-label="Type repository name to confirm" />
          <button type="button" class="danger-btn" disabled={typed !== publicRepo.full_name} onClick={confirmPublic}>I understand — use this public repo</button>
        </div>
      )}
      <p class="muted">The token is sent only to api.github.com and uploads.github.com. It is never logged or placed in a URL.</p>
    </section>
  );
}

/** "Sign in with GitHub" status and actions (shown when the build has OAuth settings). */
function SignInCard() {
  const app = useApp();
  const o = app.oauth;
  return (
    <div class="card">
      <h2>Sign in with GitHub</h2>
      {o.expired && !o.signedIn && <p role="alert" class="notice error">Your GitHub sign-in expired. Please sign in again.</p>}
      {!o.signedIn && (
        <>
          {o.state === 'error' && <p role="alert" class="notice error">{o.message}</p>}
          <p>No tokens to create. GitHub asks you to approve fsave-web, which can only reach the repository you choose.</p>
          <div class="actions">
            <button type="button" class="primary" onClick={app.signIn}>Sign in with GitHub</button>
          </div>
        </>
      )}
      {o.signedIn && (
        <>
          {o.state === 'checking' && <p role="status">Checking your storage repository…</p>}
          {o.state === 'ok' && (
            <p role="status" class="notice ok">
              ✓ Signed in. Connected to <code>{app.settings.repo}</code>.{' '}
              <button type="button" class="link" onClick={app.leaveSettings}>Go to my saves →</button>
            </p>
          )}
          {o.state === 'needs-install' && (
            <>
              <p role="alert" class="notice error">
                You're signed in, but fsave-web doesn't have access to <code>{o.repo}</code> yet.
              </p>
              <ol>
                <li>Click <strong>Choose the storage repository</strong> below (opens GitHub).</li>
                <li>Under <em>Repository access</em> pick <strong>Only select repositories</strong>, then choose just your storage repo.</li>
                <li>Click <strong>Install</strong> (or <strong>Save</strong>). You'll come back here automatically.</li>
              </ol>
              <div class="actions">
                <a class="primary button" href={installUrl()}>Choose the storage repository</a>
                <button type="button" onClick={() => void app.recheck()}>I've done this — check again</button>
              </div>
            </>
          )}
          {o.state === 'public' && (
            <p role="alert" class="notice error">
              <code>{o.repo}</code> is PUBLIC, so anyone could read your saves. Make it private on GitHub, then check again.{' '}
              <button type="button" class="link" onClick={() => void app.recheck()}>Check again</button>
            </p>
          )}
          {o.state === 'no-write' && (
            <p role="alert" class="notice error">
              Signed in, but fsave-web can't write to <code>{o.repo}</code>. Re-open the GitHub App settings and allow <em>Contents: Read and write</em>.{' '}
              <button type="button" class="link" onClick={() => void app.recheck()}>Check again</button>
            </p>
          )}
          {o.state === 'error' && (
            <p role="alert" class="notice error">
              {o.message} <button type="button" class="link" onClick={() => void app.recheck()}>Try again</button>
            </p>
          )}
          <div class="actions">
            <button type="button" onClick={app.signOut}>Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}
