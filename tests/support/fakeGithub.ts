// In-memory fake of the slice of the GitHub REST API that fsave-web uses.
// Shared by Vitest (via MSW) and Playwright (via page.route).
import { createHash } from 'node:crypto';

export interface FakeReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
}
export interface FakeRes {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string | null;
}

const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');
export const gitSha = (b: Buffer) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

export class FakeGithub {
  owner = 'me';
  repo = 'fsave-storage';
  token = 'github_pat_test';
  isPrivate = true;
  exists = true;
  branch = 'main';
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, Commit>();
  head = '';
  releases = new Map<number, { id: number; tag: string; assets: number[] }>();
  assets = new Map<number, { name: string; data: Buffer }>();
  tags = new Set<string>();
  calls: string[] = [];
  nextId = 100;
  /** Test hooks */
  beforeUpdateRef?: () => void;
  failBlobAfter?: number;
  rateLimitOnce?: { retryAfter: number };
  private blobCount = 0;

  constructor(o: { empty?: boolean } = {}) {
    if (!o.empty) this.initCommit();
  }

  private initCommit() {
    const sha = this.addBlob(Buffer.from('# fsave storage\n'));
    this.head = this.makeCommit(new Map([['README.md', sha]]), [], 'init');
  }

  addBlob(b: Buffer): string {
    const s = gitSha(b);
    this.blobs.set(s, b);
    return s;
  }
  private makeTree(m: Map<string, string>): string {
    const sha = sha1(JSON.stringify([...m].sort()));
    this.trees.set(sha, m);
    return sha;
  }
  private makeCommit(tree: Map<string, string>, parents: string[], message: string): string {
    const t = this.makeTree(tree);
    const sha = sha1(JSON.stringify({ t, parents, message, n: this.commits.size }));
    this.commits.set(sha, { tree: t, parents, message });
    return sha;
  }
  /** Simulates another device committing to the branch. */
  externalCommit(path: string, content: string) {
    const cur = new Map(this.trees.get(this.commits.get(this.head)!.tree)!);
    cur.set(path, this.addBlob(Buffer.from(content)));
    this.head = this.makeCommit(cur, [this.head], 'external');
  }
  files(): Map<string, Buffer> {
    const t = this.trees.get(this.commits.get(this.head)!.tree)!;
    return new Map([...t].map(([p, s]) => [p, this.blobs.get(s)!]));
  }
  text(path: string): string | undefined {
    return this.files().get(path)?.toString('utf8');
  }
  commitCount(): number {
    let n = 0;
    for (let c = this.head; c; c = this.commits.get(c)!.parents[0]) n++;
    return n;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): FakeRes {
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }
  private err(status: number, message: string, headers: Record<string, string> = {}) {
    return this.json(status, { message }, headers);
  }

  handle(req: FakeReq): FakeRes {
    const u = new URL(req.url);
    const p = u.pathname;
    this.calls.push(`${req.method} ${u.host}${p}`);
    if (req.headers['authorization'] !== `Bearer ${this.token}`) return this.err(401, 'Bad credentials');
    if (this.rateLimitOnce) {
      const { retryAfter } = this.rateLimitOnce;
      this.rateLimitOnce = undefined;
      return this.err(429, 'You have exceeded a secondary rate limit', { 'retry-after': String(retryAfter) });
    }
    const body = () => JSON.parse(req.body?.toString('utf8') ?? '{}');
    const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) };

    if (p === '/rate_limit') return this.json(200, { resources: { core: { limit: 5000, remaining: 4990, reset: Math.floor(Date.now() / 1000) + 3600 } } }, rate);
    if (p === '/user') return this.json(200, { login: this.owner });
    if (p === '/user/repos' && req.method === 'POST') {
      this.exists = true;
      this.isPrivate = body().private !== false;
      this.initCommit();
      return this.json(201, this.repoInfo());
    }
    const base = `/repos/${this.owner}/${this.repo}`;
    if (!p.startsWith(base) || !this.exists) return this.err(404, 'Not Found');
    const rest = p.slice(base.length);
    const empty = !this.head;

    if (rest === '' && req.method === 'GET') return this.json(200, this.repoInfo(), rate);
    if (rest === '/contents/README.md' && req.method === 'PUT') {
      this.initCommit();
      return this.json(201, {});
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      if (empty) return this.err(409, 'Git Repository is empty.');
      return decodeURIComponent(m[1]) === this.branch ? this.json(200, { object: { sha: this.head } }) : this.err(404, 'Not Found');
    }
    if ((m = /^\/git\/commits\/(\w+)$/.exec(rest)) && req.method === 'GET') {
      const c = this.commits.get(m[1]);
      return c ? this.json(200, { sha: m[1], tree: { sha: c.tree } }) : this.err(404, 'Not Found');
    }
    if ((m = /^\/git\/trees\/(\w+)$/.exec(rest)) && req.method === 'GET') {
      const t = this.trees.get(m[1]);
      if (!t) return this.err(404, 'Not Found');
      return this.json(200, { sha: m[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: this.blobs.get(sha)!.length })) });
    }
    if (rest === '/git/blobs' && req.method === 'POST') {
      if (this.failBlobAfter !== undefined && this.blobCount++ >= this.failBlobAfter) return this.err(500, 'Server Error');
      const b = body();
      return this.json(201, { sha: this.addBlob(Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8')) });
    }
    if ((m = /^\/git\/blobs\/(\w+)$/.exec(rest)) && req.method === 'GET') {
      const b = this.blobs.get(m[1]);
      return b ? { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: b } : this.err(404, 'Not Found');
    }
    if (rest === '/git/trees' && req.method === 'POST') {
      const b = body();
      const t = new Map(this.trees.get(b.base_tree) ?? []);
      for (const e of b.tree as { path: string; sha?: string | null; content?: string }[]) {
        if (e.sha === null) t.delete(e.path);
        else if (e.content !== undefined) t.set(e.path, this.addBlob(Buffer.from(e.content, 'utf8')));
        else if (e.sha && this.blobs.has(e.sha)) t.set(e.path, e.sha);
        else return this.err(422, 'GitRPC::BadObjectState');
      }
      return this.json(201, { sha: this.makeTree(t) });
    }
    if (rest === '/git/commits' && req.method === 'POST') {
      const b = body();
      const tree = this.trees.get(b.tree);
      if (!tree) return this.err(422, 'Tree SHA does not exist');
      return this.json(201, { sha: this.makeCommit(tree, b.parents, b.message) });
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === 'PATCH') {
      this.beforeUpdateRef?.();
      this.beforeUpdateRef = undefined;
      const b = body();
      const c = this.commits.get(b.sha);
      if (!c || c.parents[0] !== this.head) return this.err(422, 'Update is not a fast forward');
      this.head = b.sha;
      return this.json(200, { object: { sha: b.sha } });
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest)) && req.method === 'GET') {
      const c = this.commits.get(u.searchParams.get('ref') ?? this.head);
      const sha = c && this.trees.get(c.tree)?.get(decodeURIComponent(m[1]));
      return sha ? { status: 200, headers: { 'content-type': 'text/plain' }, body: this.blobs.get(sha)! } : this.err(404, 'Not Found');
    }
    if (rest === '/releases' && req.method === 'POST') {
      const b = body();
      const id = this.nextId++;
      this.releases.set(id, { id, tag: b.tag_name, assets: [] });
      this.tags.add(b.tag_name);
      return this.json(201, { id, tag_name: b.tag_name });
    }
    if ((m = /^\/releases\/tags\/(.+)$/.exec(rest))) {
      const r = [...this.releases.values()].find((x) => x.tag === decodeURIComponent(m![1]));
      return r ? this.json(200, { id: r.id, tag_name: r.tag }) : this.err(404, 'Not Found');
    }
    if ((m = /^\/releases\/(\d+)\/assets$/.exec(rest)) && req.method === 'POST') {
      const r = this.releases.get(+m[1]);
      if (!r || u.host !== 'uploads.github.com') return this.err(404, 'Not Found');
      const id = this.nextId++;
      const name = u.searchParams.get('name')!;
      this.assets.set(id, { name, data: req.body ?? Buffer.alloc(0) });
      r.assets.push(id);
      return this.json(201, { id, name, size: (req.body ?? Buffer.alloc(0)).length });
    }
    if ((m = /^\/releases\/(\d+)$/.exec(rest)) && req.method === 'DELETE') {
      const r = this.releases.get(+m[1]);
      if (!r) return this.err(404, 'Not Found');
      r.assets.forEach((a) => this.assets.delete(a));
      this.releases.delete(r.id);
      return { status: 204, headers: {}, body: null };
    }
    if ((m = /^\/releases\/assets\/(\d+)$/.exec(rest))) {
      const a = this.assets.get(+m[1]);
      return a ? { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: a.data } : this.err(404, 'Not Found');
    }
    if ((m = /^\/git\/refs\/tags\/(.+)$/.exec(rest)) && req.method === 'DELETE') {
      const t = decodeURIComponent(m[1]);
      if (!this.tags.delete(t)) return this.err(422, 'Reference does not exist');
      return { status: 204, headers: {}, body: null };
    }
    return this.err(404, `Unhandled fake route: ${req.method} ${p}`);
  }

  private repoInfo() {
    return { name: this.repo, full_name: `${this.owner}/${this.repo}`, private: this.isPrivate, default_branch: this.branch, permissions: { push: true } };
  }
}
