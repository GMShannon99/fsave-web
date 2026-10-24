import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { GitHubClient } from '../api/github';
import { loadSettings, loadToken, parseRepo, saveSettings, saveToken, type Settings } from '../storage/config';
import { Browse } from './Browse';
import { Detail } from './Detail';
import { NewSave } from './NewSave';
import { SettingsPage } from './SettingsPage';

export interface Ctx {
  settings: Settings;
  token: string;
  remembered: boolean;
  client: GitHubClient | null;
  branch: string;
  updateSettings(patch: Partial<Settings>): void;
  setToken(token: string, remember: boolean): void;
  /** Leaves the (first-run) settings screen for the saves list. */
  leaveSettings(): void;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export interface Route {
  page: 'browse' | 'new' | 'save' | 'settings';
  id?: string;
  repo?: string;
}

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const repo = new URLSearchParams(query).get('repo') ?? undefined;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'new') return { page: 'new' };
  if (parts[0] === 'settings') return { page: 'settings', repo };
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
    return {
      settings,
      token: tok.token,
      remembered: tok.remembered,
      client: r && tok.token ? new GitHubClient({ token: tok.token, owner: r.owner, repo: r.repo }) : null,
      branch: settings.branch || 'main',
      updateSettings(patch) {
        const next = { ...settings, ...patch };
        saveSettings(next);
        setSettings(next);
      },
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
  }, [settings, tok]);

  const configured = !!ctx.client;
  useEffect(() => {
    if (!configured) setSticky(true);
  }, [configured]);
  let page: ComponentChildren;
  if (route.page === 'settings' || !configured || sticky) page = <SettingsPage firstRun={!configured} />;
  else if (route.page === 'new') page = <NewSave />;
  else if (route.page === 'save') page = <Detail id={route.id!} key={route.id} />;
  else page = <Browse />;

  const nav = (p: Route['page'], href: string, label: string) => (
    <a href={href} aria-current={route.page === p || (p === 'settings' && !configured) ? 'page' : undefined}>
      {label}
    </a>
  );

  return (
    <AppCtx.Provider value={ctx}>
      <header class="top">
        <a class="brand" href="#/">
          <span aria-hidden="true">💾</span> fsave-web
        </a>
        <nav aria-label="Main">
          {nav('browse', '#/', 'Saves')}
          {nav('new', '#/new', 'New save')}
          {nav('settings', '#/settings', 'Settings')}
        </nav>
      </header>
      <main>{page}</main>
    </AppCtx.Provider>
  );
}
