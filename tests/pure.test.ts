import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compilePatterns, isExcluded } from '../src/storage/excludes';
import { Sha256, gitBlobSha, hashBlob, sha256Hex } from '../src/storage/hash';
import {
  buildManifest, classify, describeDevice, isValidSaveId, matchesQuery, newSaveId, parseTags, summarize, upsertSummary, removeSummary, emptyIndex, MAX_INDEX_PATHS,
} from '../src/storage/manifest';
import { buildTree, dedupePaths, formatBytes, hasGitComponent, leafPaths, normalizePath, safeFileName } from '../src/storage/paths';
import { DEFAULT_EXCLUDES, MB, type ManifestFile } from '../src/storage/types';

describe('paths', () => {
  it('normalises separators, dots and unicode', () => {
    expect(normalizePath('a\\b//./c.txt')).toBe('a/b/c.txt');
    expect(normalizePath('/lead/trail/')).toBe('lead/trail');
    expect(normalizePath('café/x')).toBe('café/x');
    expect(normalizePath('my folder/日本語 file (1).txt')).toBe('my folder/日本語 file (1).txt');
  });
  it('rejects traversal', () => {
    expect(() => normalizePath('a/../../etc/passwd')).toThrow();
  });
  it('detects .git components case-insensitively', () => {
    expect(hasGitComponent('proj/.git/config')).toBe(true);
    expect(hasGitComponent('proj/.GIT/x')).toBe(true);
    expect(hasGitComponent('proj/.github/x')).toBe(false);
  });
  it('dedupes colliding paths', () => {
    expect(dedupePaths(['a/x.txt', 'a/x.txt', 'a/x.txt', 'b'])).toEqual(['a/x.txt', 'a/x (2).txt', 'a/x (3).txt', 'b']);
  });
  it('handles very deep nesting in trees', () => {
    const deep = Array.from({ length: 60 }, (_, i) => `d${i}`).join('/') + '/leaf.txt';
    const tree = buildTree([{ path: deep }, { path: 'top.txt' }]);
    expect(tree.map((n) => n.name)).toEqual(['d0', 'top.txt']); // folders first
    expect(leafPaths(tree[0])).toEqual([deep]);
  });
  it('formats bytes and file names', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(50 * MB)).toBe('50.0 MB');
    expect(safeFileName('a/b:c?.zip')).toBe('a_b_c_.zip');
  });
});

describe('exclude patterns', () => {
  const m = compilePatterns([...DEFAULT_EXCLUDES, '*.log', 'build/out/', '/root-only.txt', '**/cache/*.tmp', '# comment', '']);
  const ex = (p: string) => isExcluded(p, m);
  it('matches defaults at any depth', () => {
    expect(ex('proj/.git/HEAD')).toBe(true);
    expect(ex('proj/node_modules/x/y.js')).toBe(true);
    expect(ex('a/b/.DS_Store')).toBe(true);
    expect(ex('Thumbs.db')).toBe(true);
  });
  it('does not over-match', () => {
    expect(ex('proj/.github/ci.yml')).toBe(false);
    expect(ex('proj/my_node_modules_notes.txt')).toBe(false);
    expect(ex('src/index.ts')).toBe(false);
  });
  it('directory-only patterns do not match files of that name', () => {
    expect(ex('a/node_modules')).toBe(false);
    expect(ex('a/node_modules/x')).toBe(true);
  });
  it('supports globs and anchoring', () => {
    expect(ex('deep/dir/server.log')).toBe(true);
    expect(ex('build/out/a.js')).toBe(true);
    expect(ex('other/build/out/a.js')).toBe(false);
    expect(ex('root-only.txt')).toBe(true);
    expect(ex('sub/root-only.txt')).toBe(false);
    expect(ex('x/y/cache/a.tmp')).toBe(true);
    expect(ex('x/cache/deeper/a.tmp')).toBe(false);
  });
});

describe('hashing', () => {
  it('matches known vectors', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await gitBlobSha(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await gitBlobSha(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
  it('streaming SHA-256 equals SubtleCrypto for awkward chunkings', async () => {
    const data = new Uint8Array(100_003).map((_, i) => (i * 31 + 7) & 255);
    const want = createHash('sha256').update(data).digest('hex');
    for (const chunk of [1, 55, 56, 63, 64, 65, 1000, 100_003]) {
      const h = new Sha256();
      for (let i = 0; i < data.length; i += chunk) h.update(data.subarray(i, i + chunk));
      expect(h.digestHex()).toBe(want);
    }
    expect(new Sha256().digestHex()).toBe(createHash('sha256').update('').digest('hex'));
  });
  it('hashBlob uses the streaming path above the threshold with identical results', async () => {
    const blob = new Blob([new Uint8Array(20_000).fill(9)]);
    const a = await hashBlob(blob, { git: false });
    const b = await hashBlob(blob, { git: false, streamThreshold: 1000 });
    expect(b.sha256).toBe(a.sha256);
    expect((await hashBlob(blob, { git: true })).gitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('manifest', () => {
  const f = (path: string, size: number, storage: 'blob' | 'release' = 'blob'): ManifestFile => ({ path, size, sha256: 'x'.repeat(64), storage });
  it('classifies by size', () => {
    expect(classify(10)).toBe('blob');
    expect(classify(50 * MB)).toBe('blob');
    expect(classify(50 * MB + 1)).toBe('release');
    expect(classify(2 * 1024 * MB + 1)).toBe('too-large');
  });
  it('builds a sorted manifest with totals and normalised tags', () => {
    const m = buildManifest({ id: 'i', name: '  My save ', tags: 'Work, work, ,Photos', note: 'n', device: 'd', files: [f('b', 2), f('a', 3, 'release')], now: new Date('2024-01-02T03:04:05Z'), releaseTag: 'save-i' });
    expect(m.files.map((x) => x.path)).toEqual(['a', 'b']);
    expect(m.totalSize).toBe(5);
    expect(m.tags).toEqual(['work', 'photos']);
    expect(m.name).toBe('My save');
    expect(m.createdAt).toBe('2024-01-02T03:04:05.000Z');
    expect(summarize(m)).toMatchObject({ fileCount: 2, hasRelease: true, totalSize: 5 });
  });
  it('generates valid sortable ids', () => {
    const id = newSaveId(new Date('2024-01-31T23:59:59Z'), new Uint8Array([0xab, 0x12]));
    expect(id).toBe('20240131-235959-ab12');
    expect(isValidSaveId(id)).toBe(true);
    expect(isValidSaveId('../x')).toBe(false);
  });
  it('caps index path samples', () => {
    const m = buildManifest({ id: 'i', name: 'n', tags: [], note: '', device: 'd', files: Array.from({ length: MAX_INDEX_PATHS + 5 }, (_, i) => f(`f${i}`, 1)) });
    const s = summarize(m);
    expect(s.paths).toHaveLength(MAX_INDEX_PATHS);
    expect(s.pathsTruncated).toBe(true);
  });
  it('upserts/removes index entries newest-first and searches by name/tag/file', () => {
    const mk = (id: string, name: string, at: string, tags: string[], files: string[]) => summarize({ ...buildManifest({ id, name, tags, note: '', device: '', files: files.map((p) => f(p, 1)) }), createdAt: at });
    let idx = upsertSummary(emptyIndex(), mk('a', 'Old', '2024-01-01', ['x'], ['one.txt']));
    idx = upsertSummary(idx, mk('b', 'New', '2024-02-01', ['holiday'], ['pics/beach.jpg']));
    idx = upsertSummary(idx, mk('a', 'Old renamed', '2024-01-01', ['x'], ['one.txt']));
    expect(idx.saves.map((s) => s.id)).toEqual(['b', 'a']);
    expect(idx.saves[1].name).toBe('Old renamed');
    expect(idx.saves.filter((s) => matchesQuery(s, 'BEACH')).map((s) => s.id)).toEqual(['b']);
    expect(idx.saves.filter((s) => matchesQuery(s, 'holiday')).length).toBe(1);
    expect(removeSummary(idx, 'a').saves).toHaveLength(1);
  });
  it('parses tags and devices', () => {
    expect(parseTags(['A', 'a', ' b '])).toEqual(['a', 'b']);
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120')).toBe('Edge on Windows');
  });
});
