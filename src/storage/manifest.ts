import type { Limits, Manifest, ManifestFile, SaveIndex, SaveSummary, StorageKind } from './types';
import { DEFAULT_LIMITS } from './types';

export const MAX_INDEX_PATHS = 300;

export function classify(size: number, limits: Limits = DEFAULT_LIMITS): StorageKind | 'too-large' {
  if (size > limits.fileMax) return 'too-large';
  return size > limits.blobMax ? 'release' : 'blob';
}

/** Sortable, unique save id: 20240131-235959-ab12. */
export function newSaveId(now = new Date(), rand?: Uint8Array): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const r = rand ?? crypto.getRandomValues(new Uint8Array(2));
  return `${stamp}-${Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const isValidSaveId = (id: string) => /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(id);

export function parseTags(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : input.split(',');
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

export function describeDevice(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `${browser} on ${os}`;
}

export function buildManifest(o: {
  id: string;
  name: string;
  tags: string[] | string;
  note: string;
  files: ManifestFile[];
  device: string;
  now?: Date;
  releaseTag?: string;
}): Manifest {
  const files = [...o.files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 1,
    id: o.id,
    name: o.name.trim() || o.id,
    tags: parseTags(o.tags),
    note: o.note,
    createdAt: (o.now ?? new Date()).toISOString(),
    source: { device: o.device },
    totalSize: files.reduce((s, f) => s + f.size, 0),
    ...(o.releaseTag ? { releaseTag: o.releaseTag } : {}),
    files,
  };
}

export function summarize(m: Manifest): SaveSummary {
  return {
    id: m.id,
    name: m.name,
    tags: m.tags,
    note: m.note,
    createdAt: m.createdAt,
    fileCount: m.files.length,
    totalSize: m.totalSize,
    hasRelease: m.files.some((f) => f.storage === 'release'),
    paths: m.files.slice(0, MAX_INDEX_PATHS).map((f) => f.path),
    ...(m.files.length > MAX_INDEX_PATHS ? { pathsTruncated: true } : {}),
  };
}

export const emptyIndex = (): SaveIndex => ({ version: 1, saves: [] });

export function parseIndex(text: string | null): SaveIndex {
  if (!text) return emptyIndex();
  const j = JSON.parse(text) as SaveIndex;
  if (!j || !Array.isArray(j.saves)) throw new Error('index.json is malformed');
  return j;
}

export function upsertSummary(index: SaveIndex, s: SaveSummary): SaveIndex {
  return {
    version: 1,
    saves: [s, ...index.saves.filter((x) => x.id !== s.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

export const removeSummary = (index: SaveIndex, id: string): SaveIndex => ({
  version: 1,
  saves: index.saves.filter((s) => s.id !== id),
});

export const toJson = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

export function matchesQuery(s: SaveSummary, q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  return [s.name, s.note, ...s.tags, ...s.paths].some((x) => x.toLowerCase().includes(n));
}
