import { GitHubError } from '../api/github';

export interface Session {
  accessToken: string;
  /** Epoch ms; null when the token does not expire. */
  expiresAt: number | null;
  refreshToken?: string;
  refreshExpiresAt?: number | null;
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const SESSION_KEY = 'fsave.session';
/** Refresh this long before the token actually expires. */
const SKEW_MS = 5 * 60_000;

interface TokenReply {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

export function sessionFromReply(r: TokenReply, now: number): Session {
  return {
    accessToken: r.access_token!,
    expiresAt: r.expires_in ? now + r.expires_in * 1000 : null,
    refreshToken: r.refresh_token,
    refreshExpiresAt: r.refresh_token_expires_in ? now + r.refresh_token_expires_in * 1000 : null,
  };
}

export interface AuthOptions {
  workerUrl: string;
  storage: KV;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called whenever the session is set or cleared. `expired` is true when it was cleared because refresh failed. */
  onChange?: (s: Session | null, expired: boolean) => void;
}

/** Holds the signed-in session, keeps the access token fresh, and signs out when it cannot. */
export class AuthManager {
  private s: Session | null;
  private inflight: Promise<Session> | null = null;
  private fetchImpl: typeof fetch;
  private now: () => number;

  constructor(private o: AuthOptions) {
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.s = this.read();
  }

  get session(): Session | null {
    return this.s;
  }

  private read(): Session | null {
    try {
      const v = JSON.parse(this.o.storage.getItem(SESSION_KEY) ?? 'null') as Session | null;
      return v && typeof v.accessToken === 'string' && v.accessToken ? v : null;
    } catch {
      return null;
    }
  }

  private set(s: Session | null, expired = false) {
    this.s = s;
    if (s) this.o.storage.setItem(SESSION_KEY, JSON.stringify(s));
    else this.o.storage.removeItem(SESSION_KEY);
    this.o.onChange?.(s, expired);
  }

  signOut() {
    this.set(null);
  }

  private async call(path: string, body: object): Promise<TokenReply & { ok: boolean; status: number }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.o.workerUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GitHubError('network', 'Could not reach the sign-in service. Check your connection and try again.');
    }
    const data = (await res.json().catch(() => ({}))) as TokenReply;
    return { ...data, ok: res.ok && !!data.access_token, status: res.status };
  }

  /** Completes sign-in with the `code` GitHub put in the redirect URL. */
  async exchangeCode(code: string): Promise<Session> {
    const r = await this.call('/token', { code });
    if (!r.ok) throw new GitHubError('auth', `GitHub sign-in failed${r.error ? ` (${r.error})` : ''}. Please try signing in again.`, r.status);
    const s = sessionFromReply(r, this.now());
    this.set(s);
    return s;
  }

  private needsRefresh(s: Session, force: boolean) {
    return force || (s.expiresAt !== null && s.expiresAt - this.now() < SKEW_MS);
  }

  /** Returns a valid access token, refreshing first when it is (nearly) expired or `force` is set. */
  async getToken(force = false): Promise<string> {
    const s = this.s;
    if (!s) throw new GitHubError('auth', 'You are signed out. Sign in with GitHub to continue.');
    if (!this.needsRefresh(s, force)) return s.accessToken;
    return (await this.refresh()).accessToken;
  }

  private refresh(): Promise<Session> {
    this.inflight ??= this.doRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async doRefresh(): Promise<Session> {
    const before = this.s!;
    const rt = before.refreshToken;
    if (!rt || (before.refreshExpiresAt && before.refreshExpiresAt < this.now())) return this.expire();
    const r = await this.call('/refresh', { refresh_token: rt });
    if (r.ok) {
      const s = sessionFromReply(r, this.now());
      this.set(s);
      return s;
    }
    // Refresh tokens are single-use: another tab may have just rotated it. Adopt its session if so.
    const stored = this.read();
    if (stored && stored.accessToken !== before.accessToken && !this.needsRefresh(stored, false)) {
      this.s = stored;
      this.o.onChange?.(stored, false);
      return stored;
    }
    // A worker outage is not a rejected refresh token: keep the session so the caller can retry.
    if (r.status >= 500) throw new GitHubError('network', 'The sign-in service is temporarily unavailable. Try again shortly.', r.status);
    return this.expire();
  }

  private expire(): never {
    this.set(null, true);
    throw new GitHubError('auth', 'Your GitHub sign-in expired. Please sign in again.');
  }
}

// ---- redirect handling ----

const STATE_KEY = 'fsave.oauthState';

export function newState(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function authorizeUrl(clientId: string, state: string): string {
  return `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, state })}`;
}

export function rememberState(store: KV, state: string) {
  store.setItem(STATE_KEY, state);
}

export type CallbackResult = { kind: 'none' } | { kind: 'code'; code: string } | { kind: 'error'; message: string };

/** Reads GitHub's redirect (`?code=…&state=…`), checking `state` against the one stored before leaving. */
export function parseCallback(search: string, store: KV): CallbackResult {
  const q = new URLSearchParams(search);
  const code = q.get('code');
  const err = q.get('error');
  if (!code && !err) return { kind: 'none' };
  const expected = store.getItem(STATE_KEY);
  store.removeItem(STATE_KEY);
  if (!expected || q.get('state') !== expected) return { kind: 'error', message: 'Sign-in could not be verified (state mismatch). Please try again.' };
  if (err || !code) return { kind: 'error', message: q.get('error_description') || 'Sign-in was cancelled.' };
  return { kind: 'code', code };
}
