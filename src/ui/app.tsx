import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { GitHubClient, describeError } from '../api/github';
import { authConfig, oauthEnabled } from '../auth/config';
import { connectStorage } from '../auth/connect';
import { AuthManager, authorizeUrl, newState, parseCallback, rememberState, type Session } from '../auth/session';
import { loadSettings, loadToken, parseRepo, saveSettings, saveToken, type Settings } from '../storage/config';
import { Browse } from './Browse';
import { Detail } from './Detail';
import { Help } from './Help';
import { NewSave } from './NewSave';
import { SettingsPage } from './SettingsPage';
import { Welcome } from './Welcome';

export interface Ctx {
  settings: Settings;
  token: string;
  remembered: boolean;
  client: GitHubClient | null;
  branch: string;
  updateSettings(patch: Partial<Settings>): void;
  setToken(token: string, remember: boolean): void;
  /** "Sign in with GitHub" state; `enabled` is false when the build has no OAuth settings. */
  oauth: OAuthState & { enabled: boolean; signedIn: boolean; expired: boolean };
  signIn(): void;
  signOut(): void;
  /** Re-checks the storage repo (e.g. after installing the GitHub App on it). */
  recheck(): Promise<void>;
  /** Leaves the (first-run) settings screen for the saves list. */
  leaveSettings(): void;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export interface OAuthState {
  state: 'idle' | 'checking' | 'ok' | 'needs-install' | 'public' | 'no-write' | 'error';
  message?: string;
  repo?: string;
}

export interface Route {
  page: 'browse' | 'new' | 'save' | 'settings' | 'help';
  id?: string;
  repo?: string;
}

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const repo = new URLSearchParams(query).get('repo') ?? undefined;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'new') return { page: 'new' };
  if (parts[0] === 'settings') return { page: 'settings', repo };
  if (parts[0] === 'help') return { page: 'help' };
  if (parts[0] === 'save' && parts[1]) return { page: 'save', id: decodeURIComponent(parts[1]), repo };
  return { page: 'browse' };
}

const useRoute = () => {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
};

export function App() {
  const route = useRoute();
  const [settings, setSettings] = useState(loadSettings);
  const [tok, setTok] = useState(loadToken);
  const [expired, setExpired] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [auth] = useState(() => {
    if (!oauthEnabled) return null;
    return new AuthManager({
      workerUrl: authConfig.workerUrl,
      storage: localStorage,
      onChange: (s, wasExpired) => {
        setSession(s);
        if (wasExpired) setExpired(true);
        if (!s) setOauth({ state: 'idle' });
      },
    });
  });
  const [session, setSession] = useState<Session | null>(() => auth?.session ?? null);
  // A saved sign-in for an already-configured repo is trusted right away; otherwise verify it first.
  const [oauth, setOauth] = useState<OAuthState>(() =>
    !auth?.session ? { state: 'idle' } : { state: settings.repo && settings.branch ? 'ok' : 'checking' },
  );
  const patchSettings = (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    saveSettings(next);
    setSettings(next);
  };

  async function recheck() {
    if (!auth) return;
    setOauth({ state: 'checking' });
    try {
      const cur = settingsRef.current;
      const r = await connectStorage({ getToken: (f) => auth.getToken(f), repo: parseRepo(cur.repo), publicConfirmed: cur.publicConfirmed });
      if (r.status === 'connected') {
        patchSettings({ repo: r.info.full_name, branch: r.info.default_branch });
        setOauth({ state: 'ok' });
      } else if (r.status === 'needs-install') setOauth({ state: 'needs-install', repo: r.repo });
      else setOauth({ state: r.status, repo: r.info.full_name });
    } catch (e) {
      setOauth({ state: 'error', message: describeError(e) });
    }
  }

  // On load: finish a GitHub redirect (?code=…), or verify an existing sign-in.
  useEffect(() => {
    if (!auth) return;
    const q = new URLSearchParams(location.search);
    const cb = parseCallback(location.search, sessionStorage);
    const justInstalled = q.has('installation_id') || q.has('setup_action');
    if (cb.kind !== 'none' || justInstalled) history.replaceState(null, '', location.pathname + location.hash);
    if (cb.kind === 'error') return setOauth({ state: 'error', message: cb.message });
    if (cb.kind === 'code') {
      setOauth({ state: 'checking' });
      setExpired(false);
      auth.exchangeCode(cb.code).then(recheck, (e) => setOauth({ state: 'error', message: describeError(e) }));
    } else if (auth.session) {
      const cur = settingsRef.current;
      if (justInstalled || !cur.repo || !cur.branch) void recheck();
      else setOauth({ state: 'ok' });
    }
  }, []);
  // Keep the first-run settings screen (and its success message) up until the user navigates away.
  const [sticky, setSticky] = useState(false);
  useEffect(() => setSticky(false), [route]);

  // A share link carries the repo name (not secret); adopt it if none is configured yet.
  useEffect(() => {
    if (route.repo && !settings.repo && parseRepo(route.repo)) {
      const s = { ...settings, repo: route.repo };
      saveSettings(s);
      setSettings(s);
    }
  }, [route.repo]);

  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const t = settings.theme === 'system' ? (dark.matches ? 'dark' : 'light') : settings.theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    dark.addEventListener('change', apply);
    return () => dark.removeEventListener('change', apply);
  }, [settings.theme]);

  const ctx = useMemo<Ctx>(() => {
    const r = parseRepo(settings.repo);
    const signedIn = !!(auth && session);
    const oauthClient =
      auth && session && r && oauth.state === 'ok' ? new GitHubClient({ getToken: (f) => auth.getToken(f), owner: r.owner, repo: r.repo }) : null;
    return {
      settings,
      token: tok.token,
      remembered: tok.remembered,
      client: oauthClient ?? (r && tok.token ? new GitHubClient({ token: tok.token, owner: r.owner, repo: r.repo }) : null),
      oauth: { ...oauth, enabled: !!auth, signedIn, expired },
      signIn() {
        const st = newState();
        rememberState(sessionStorage, st);
        location.assign(authorizeUrl(authConfig.clientId, st));
      },
      signOut() {
        auth?.signOut();
        setExpired(false);
      },
      recheck,
      branch: settings.branch || 'main',
      updateSettings: patchSettings,
      leaveSettings() {
        setSticky(false);
        if (location.hash === '#/' || location.hash === '') window.dispatchEvent(new HashChangeEvent('hashchange'));
        else location.hash = '#/';
      },
      setToken(token, remember) {
        saveToken(token, remember);
        setTok({ token, remembered: remember && !!token });
      },
    };
  }, [settings, tok, session, oauth, expired]);

  const configured = !!ctx.client;
  // With sign-in available, being signed out shows the plain welcome screen (never Settings).
  const welcome = !configured && ctx.oauth.enabled && route.page !== 'settings';
  useEffect(() => {
    if (!configured && !ctx.oauth.enabled) setSticky(true);
  }, [configured]);
  let page: ComponentChildren;
  if (welcome) page = <Welcome />;
  else if (route.page === 'settings' || !configured || sticky) page = <SettingsPage firstRun={!configured} />;
  else if (route.page === 'new') page = <NewSave />;
  else if (route.page === 'save') page = <Detail id={route.id!} key={route.id} />;
  else if (route.page === 'help') page = <Help />;
  else page = <Browse />;

  const nav = (p: Route['page'], href: string, label: string) => (
    <a href={href} aria-current={route.page === p || (p === 'settings' && !configured) ? 'page' : undefined}>
      {label}
    </a>
  );

  return (
    <AppCtx.Provider value={ctx}>
      {!welcome && (
        <header class="top">
          <a class="brand" href="#/">
            <span aria-hidden="true">💾</span> fsave-web
          </a>
          <nav aria-label="Main">
            {nav('browse', '#/', 'My files')}
            {nav('new', '#/new', 'Upload files')}
            {nav('help', '#/help', 'Help')}
            {nav('settings', '#/settings', 'Settings')}
          </nav>
        </header>
      )}
      <main>{page}</main>
    </AppCtx.Provider>
  );
}
