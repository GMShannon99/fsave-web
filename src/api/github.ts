// Minimal GitHub REST client. The token is only ever sent to api.github.com / uploads.github.com
// and is never logged or included in error messages.

export type ErrorKind =
  | 'auth'
  | 'permission'
  | 'not-found'
  | 'rate-limit'
  | 'network'
  | 'conflict'
  | 'empty-repo'
  | 'validation'
  | 'abort'
  | 'server'
  | 'other';

export class GitHubError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public status?: number,
    public resetAt?: Date,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RepoInfo {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: { push?: boolean; admin?: boolean };
}
export interface RateLimit {
  limit: number;
  remaining: number;
  reset: Date;
}
export interface TreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}
export interface TreeInput {
  path: string;
  mode: '100644';
  type: 'blob';
  sha?: string | null;
  content?: string;
}
export interface ReleaseInfo {
  id: number;
  tag_name: string;
  upload_url?: string;
}
export interface AssetInfo {
  id: number;
  name: string;
  size: number;
}

export interface ClientOptions {
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Longest rate-limit wait (ms) the client will sit out automatically before surfacing an error. */
  maxAutoWaitMs?: number;
}

interface ReqOpts {
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
  as?: 'json' | 'text' | 'buffer' | 'none';
}

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const VERSION = '2022-11-28';

export function formatReset(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Maps an HTTP error response to a typed, user-presentable error. */
export function errorFromResponse(
  status: number,
  header: (name: string) => string | null,
  bodyText: string,
  now = Date.now(),
): GitHubError {
  let message = '';
  try {
    message = (JSON.parse(bodyText) as { message?: string }).message ?? '';
  } catch {
    /* non-JSON body */
  }
  const remaining = header('x-ratelimit-remaining');
  const retryAfter = header('retry-after');
  const resetHdr = header('x-ratelimit-reset');
  if (status === 429 || (status === 403 && (remaining === '0' || retryAfter || /rate limit/i.test(message)))) {
    const resetAt = retryAfter
      ? new Date(now + Number(retryAfter) * 1000)
      : resetHdr
        ? new Date(Number(resetHdr) * 1000)
        : new Date(now + 60_000);
    return new GitHubError(
      'rate-limit',
      `GitHub API rate limit reached. It resets at ${formatReset(resetAt)}.`,
      status,
      resetAt,
    );
  }
  switch (status) {
    case 401:
      return new GitHubError('auth', 'GitHub rejected the token: it is invalid, revoked or expired. Create a new one in Settings.', status);
    case 403:
      return new GitHubError(
        'permission',
        `The token does not have permission for this action${message ? ` (${message})` : ''}. It needs Contents: read & write on the storage repo.`,
        status,
      );
    case 404:
      return new GitHubError(
        'not-found',
        'Not found. Check the repository name, and that the token is granted access to that repository (GitHub reports inaccessible private repos as 404).',
        status,
      );
    case 409:
      return /empty/i.test(message)
        ? new GitHubError('empty-repo', 'The repository is empty.', status)
        : new GitHubError('conflict', message || 'Conflict', status);
    case 422:
      return /fast.?forward/i.test(message)
        ? new GitHubError('conflict', 'The branch moved while saving.', status)
        : new GitHubError('validation', `GitHub rejected the request: ${message || 'validation failed'}`, status);
    default:
      return status >= 500
        ? new GitHubError('server', `GitHub had a server error (${status}). Try again shortly.`, status)
        : new GitHubError('other', `GitHub returned ${status}${message ? `: ${message}` : ''}`, status);
  }
}

export function describeError(e: unknown): string {
  if (e instanceof GitHubError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export class GitHubClient {
  readonly owner: string;
  readonly repo: string;
  lastRateLimit?: { remaining: number; limit: number; reset: Date };
  private token: string;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private maxAutoWaitMs: number;

  constructor(o: ClientOptions) {
    this.token = o.token;
    this.owner = o.owner;
    this.repo = o.repo;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAutoWaitMs = o.maxAutoWaitMs ?? 30_000;
  }

  private get base() {
    return `/repos/${this.owner}/${this.repo}`;
  }

  private headers(accept?: string, json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': VERSION,
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private noteRate(res: Response) {
    const rem = res.headers.get('x-ratelimit-remaining');
    const lim = res.headers.get('x-ratelimit-limit');
    const reset = res.headers.get('x-ratelimit-reset');
    if (rem && lim && reset) this.lastRateLimit = { remaining: +rem, limit: +lim, reset: new Date(+reset * 1000) };
  }

  async request<T = unknown>(method: string, path: string, o: ReqOpts = {}): Promise<T> {
    const url = path.startsWith('http') ? path : API + path;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: this.headers(o.accept, o.body !== undefined),
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          signal: o.signal,
        });
      } catch (e) {
        if (o.signal?.aborted || (e as Error)?.name === 'AbortError') throw new GitHubError('abort', 'Cancelled.');
        throw new GitHubError('network', 'Network error: could not reach GitHub. Check your connection and try again.');
      }
      this.noteRate(res);
      if (res.ok) {
        switch (o.as ?? 'json') {
          case 'none':
            return undefined as T;
          case 'text':
            return (await res.text()) as T;
          case 'buffer':
            return (await res.arrayBuffer()) as T;
          default:
            return (res.status === 204 ? undefined : await res.json()) as T;
        }
      }
      const err = errorFromResponse(res.status, (n) => res.headers.get(n), await res.text().catch(() => ''));
      if (err.kind === 'rate-limit' && err.resetAt && attempt < 2) {
        const wait = err.resetAt.getTime() - Date.now() + 1000;
        if (wait <= this.maxAutoWaitMs) {
          await this.sleep(Math.max(wait, 0));
          continue;
        }
      }
      if (err.kind === 'server' && attempt < 1) {
        await this.sleep(1000);
        continue;
      }
      throw err;
    }
  }

  // ---- account / repo ----
  getUser() {
    return this.request<{ login: string }>('GET', '/user');
  }
  getRepo(signal?: AbortSignal) {
    return this.request<RepoInfo>('GET', this.base, { signal });
  }
  async getRateLimit(): Promise<RateLimit> {
    const r = await this.request<{ resources: { core: { limit: number; remaining: number; reset: number } } }>('GET', '/rate_limit');
    const c = r.resources.core;
    return { limit: c.limit, remaining: c.remaining, reset: new Date(c.reset * 1000) };
  }
  createPrivateRepo(name: string) {
    return this.request<RepoInfo>('POST', '/user/repos', {
      body: { name, private: true, auto_init: true, description: 'fsave-web storage' },
    });
  }
  /** Initialises a completely empty repository so the Git Data API works. */
  async initEmptyRepo(branch: string) {
    await this.request('PUT', `${this.base}/contents/README.md`, {
      body: { message: 'Initialise fsave storage', content: btoa('# fsave storage\n'), branch },
    });
  }

  // ---- git data ----
  async getHead(branch: string, signal?: AbortSignal): Promise<{ commitSha: string; treeSha: string }> {
    let ref: { object: { sha: string } };
    try {
      ref = await this.request('GET', `${this.base}/git/ref/heads/${encodePath(branch)}`, { signal });
    } catch (e) {
      if (!(e instanceof GitHubError) || e.kind !== 'empty-repo') throw e;
      await this.initEmptyRepo(branch);
      ref = await this.request('GET', `${this.base}/git/ref/heads/${encodePath(branch)}`, { signal });
    }
    const commit = await this.request<{ tree: { sha: string } }>('GET', `${this.base}/git/commits/${ref.object.sha}`, { signal });
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  }
  getTree(sha: string, recursive: boolean, signal?: AbortSignal) {
    return this.request<{ tree: TreeItem[]; truncated: boolean }>('GET', `${this.base}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, { signal });
  }
  async createBlob(base64: string, signal?: AbortSignal): Promise<string> {
    const r = await this.request<{ sha: string }>('POST', `${this.base}/git/blobs`, { body: { content: base64, encoding: 'base64' }, signal });
    return r.sha;
  }
  async createTree(baseTree: string, tree: TreeInput[], signal?: AbortSignal): Promise<string> {
    const r = await this.request<{ sha: string }>('POST', `${this.base}/git/trees`, { body: { base_tree: baseTree, tree }, signal });
    return r.sha;
  }
  async createCommit(message: string, tree: string, parent: string, signal?: AbortSignal): Promise<string> {
    const r = await this.request<{ sha: string }>('POST', `${this.base}/git/commits`, { body: { message, tree, parents: [parent] }, signal });
    return r.sha;
  }
  updateRef(branch: string, sha: string, signal?: AbortSignal) {
    return this.request('PATCH', `${this.base}/git/refs/heads/${encodePath(branch)}`, { body: { sha, force: false }, signal });
  }
  deleteTagRef(tag: string) {
    return this.request('DELETE', `${this.base}/git/refs/tags/${encodePath(tag)}`, { as: 'none' });
  }
  getBlobBytes(sha: string, signal?: AbortSignal) {
    return this.request<ArrayBuffer>('GET', `${this.base}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', as: 'buffer', signal });
  }
  /** Reads a text file at a commit; returns null if it does not exist. */
  async getTextAt(path: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    try {
      return await this.request<string>('GET', `${this.base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
        accept: 'application/vnd.github.raw+json',
        as: 'text',
        signal,
      });
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'not-found') return null;
      throw e;
    }
  }

  // ---- releases ----
  createRelease(tag: string, name: string, target: string, signal?: AbortSignal) {
    return this.request<ReleaseInfo>('POST', `${this.base}/releases`, {
      body: { tag_name: tag, name, target_commitish: target, body: 'fsave-web large-file storage', draft: false, prerelease: true },
      signal,
    });
  }
  async deleteReleaseByTag(tag: string): Promise<void> {
    try {
      const rel = await this.request<ReleaseInfo>('GET', `${this.base}/releases/tags/${encodePath(tag)}`);
      await this.request('DELETE', `${this.base}/releases/${rel.id}`, { as: 'none' });
    } catch (e) {
      if (!(e instanceof GitHubError && e.kind === 'not-found')) throw e;
    }
    try {
      await this.deleteTagRef(tag);
    } catch (e) {
      if (!(e instanceof GitHubError && (e.kind === 'not-found' || e.kind === 'validation'))) throw e;
    }
  }
  downloadAsset(id: number, signal?: AbortSignal) {
    return this.request<ArrayBuffer>('GET', `${this.base}/releases/assets/${id}`, { accept: 'application/octet-stream', as: 'buffer', signal });
  }

  /** Uploads a release asset; uses XHR when available so upload progress can be reported. */
  uploadAsset(
    releaseId: number,
    name: string,
    data: Blob,
    o: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
  ): Promise<AssetInfo> {
    const url = `${UPLOADS}${this.base}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const h = { ...this.headers(), 'Content-Type': 'application/octet-stream' };
    if (typeof XMLHttpRequest === 'undefined') {
      return this.fetchImpl(url, { method: 'POST', headers: h, body: data, signal: o.signal }).then(
        async (res) => {
          if (!res.ok) throw errorFromResponse(res.status, (n) => res.headers.get(n), await res.text().catch(() => ''));
          o.onProgress?.(1);
          return (await res.json()) as AssetInfo;
        },
        (e) => {
          throw o.signal?.aborted || e?.name === 'AbortError' ? new GitHubError('abort', 'Cancelled.') : new GitHubError('network', 'Network error during upload.');
        },
      );
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && o.onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          o.onProgress?.(1);
          resolve(JSON.parse(xhr.responseText) as AssetInfo);
        } else reject(errorFromResponse(xhr.status, (n) => xhr.getResponseHeader(n), xhr.responseText));
      };
      xhr.onerror = () => reject(new GitHubError('network', 'Network error during upload. Nothing was committed.'));
      xhr.onabort = () => reject(new GitHubError('abort', 'Cancelled.'));
      const onAbort = () => xhr.abort();
      if (o.signal?.aborted) return reject(new GitHubError('abort', 'Cancelled.'));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      xhr.send(data);
    });
  }
}
