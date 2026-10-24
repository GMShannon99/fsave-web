import { DEFAULT_EXCLUDES } from './types';

export interface Settings {
  /** "owner/name" of the storage repo. */
  repo: string;
  branch: string;
  theme: 'system' | 'light' | 'dark';
  excludes: string[];
  /** Repo the user explicitly confirmed is OK to use even though it is public. */
  publicConfirmed?: string;
}

const SETTINGS_KEY = 'fsave.settings';
const TOKEN_KEY = 'fsave.token';

export const defaultSettings = (): Settings => ({ repo: '', branch: '', theme: 'system', excludes: [...DEFAULT_EXCLUDES] });

export function loadSettings(): Settings {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return defaultSettings();
  }
}
export const saveSettings = (s: Settings) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

/** sessionStorage by default; localStorage only when the user opted in to "remember on this device". */
export function loadToken(): { token: string; remembered: boolean } {
  const local = localStorage.getItem(TOKEN_KEY);
  if (local) return { token: local, remembered: true };
  return { token: sessionStorage.getItem(TOKEN_KEY) ?? '', remembered: false };
}

export function saveToken(token: string, remember: boolean) {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  if (!token) return;
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
}

export function parseRepo(s: string): { owner: string; repo: string } | null {
  const m = /^\s*([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\s*$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}
