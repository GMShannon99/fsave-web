import { useState } from 'preact/hooks';
import { GitHubClient, GitHubError, describeError, formatReset, type RateLimit, type RepoInfo } from '../api/github';
import { parseRepo } from '../storage/config';
import { DEFAULT_EXCLUDES } from '../storage/types';
import { useApp } from './app';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

export function SettingsPage({ firstRun }: { firstRun: boolean }) {
  const app = useApp();
  // Without the sign-in feature the pasted token is the only way in, so it is shown up front.
  const tokenOnly = !app.oauth.enabled;
  const [token, setToken] = useState(app.token);
  const [remember, setRemember] = useState(app.remembered);
  const [repo, setRepo] = useState(app.settings.repo);
  const [excludes, setExcludes] = useState(app.settings.excludes.join('\n'));
  const [theme, setTheme] = useState(app.settings.theme);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [rate, setRate] = useState<RateLimit | null>(null);
  const [missingRepo, setMissingRepo] = useState(false);
  const [publicRepo, setPublicRepo] = useState<RepoInfo | null>(null);
  const [typed, setTyped] = useState('');
  const [advOpen, setAdvOpen] = useState(tokenOnly);

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
      // Signed in with GitHub: save the form and re-check the storage folder with that sign-in.
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
      <h1>{firstRun && tokenOnly ? 'Welcome — connect your storage' : 'Settings'}</h1>
      {firstRun && tokenOnly && <p>fsave-web stores your files in a <strong>private GitHub repository you own</strong>. Connect one to get started.</p>}

      {app.oauth.enabled && (
        <div class="card">
          <h2>Your account</h2>
          {app.oauth.signedIn ? (
            <>
              <p>✓ You're signed in with GitHub. Your files are kept in your private cloud storage.</p>
              <div class="actions"><button type="button" onClick={app.signOut}>Sign out</button></div>
              <p class="hint">Sign out on any computer you share with other people.</p>
            </>
          ) : (
            <>
              <p>You're not signed in.</p>
              <div class="actions"><button type="button" class="primary big" onClick={app.signIn}>Sign in with GitHub</button></div>
            </>
          )}
        </div>
      )}

      <form
        class="card"
        onSubmit={(e) => {
          e.preventDefault();
          persist();
          setPrefsSaved(true);
        }}
      >
        <h2>How it looks</h2>
        <label>
          Theme
          <select value={theme} onChange={(e) => { setTheme((e.target as HTMLSelectElement).value as typeof theme); setPrefsSaved(false); }}>
            <option value="system">Match my computer</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <h2>Files to skip when uploading</h2>
        <label>
          One per line. Handy for things you never want to save, like <code>node_modules/</code> or <code>*.log</code>.
          <textarea rows={5} value={excludes} onInput={(e) => { setExcludes((e.target as HTMLTextAreaElement).value); setPrefsSaved(false); }} spellcheck={false} />
        </label>
        <button type="button" class="link" onClick={() => { setExcludes(DEFAULT_EXCLUDES.join('\n')); setPrefsSaved(false); }}>Reset to the usual list</button>
        <div class="actions">
          <button type="submit" class="primary">Save settings</button>
          {prefsSaved && <span role="status" class="ok">✓ Saved</span>}
        </div>
      </form>

      <details class="advanced" open={advOpen} onToggle={(e) => setAdvOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced (for troubleshooting)</summary>
        <form
          class="card"
          onSubmit={(e) => {
            e.preventDefault();
            void test();
          }}
        >
          <h2>Access token</h2>
          <p class="muted">Only needed if signing in with GitHub isn't working. This connects with a token you create yourself instead.</p>
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
          <label>
            Repository (owner/name)
            <input value={repo} onInput={(e) => setRepo((e.target as HTMLInputElement).value)} placeholder="your-name/fsave-storage" spellcheck={false} />
          </label>
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
            {msg.kind === 'ok' && <button type="button" class="link" onClick={app.leaveSettings}>Go to my files →</button>}
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
      </details>
    </section>
  );
}
