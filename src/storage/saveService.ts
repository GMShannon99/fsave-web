import { GitHubClient } from '../api/github';
import { commitAtomic, fileEntry, textEntry } from './commit';
import { hashBlob } from './hash';
import type { Hasher } from './hashClient';
import { buildManifest, classify, newSaveId, parseIndex, summarize, toJson, upsertSummary } from './manifest';
import { basename, dedupePaths, formatBytes, hasGitComponent, normalizePath, repoFilePath, safeFileName } from './paths';
import { DEFAULT_LIMITS, INDEX_PATH, releaseTag, type Limits, type ManifestFile } from './types';

export interface PendingFile {
  file: Blob;
  path: string;
}

export interface SaveInput {
  name: string;
  tags: string;
  note: string;
  device: string;
  files: PendingFile[];
}

export type ProgressEvent =
  | { type: 'phase'; phase: 'hashing' | 'uploading' | 'committing' }
  | { type: 'file'; path: string; fraction: number }
  | { type: 'overall'; bytesDone: number; bytesTotal: number; filesDone: number; filesTotal: number };

export interface SaveResult {
  id: string;
  commitSha: string;
  fileCount: number;
  totalSize: number;
  uploadedBlobs: number;
  reusedBlobs: number;
  releaseFiles: number;
}

export interface SaveOptions {
  signal?: AbortSignal;
  limits?: Limits;
  hasher?: Hasher;
  onProgress?: (e: ProgressEvent) => void;
  now?: Date;
}

export class TooLargeError extends Error {
  constructor(public paths: string[], limit: number) {
    super(`${paths.length === 1 ? `"${paths[0]}" is` : `${paths.length} files are`} larger than the ${formatBytes(limit)} per-file limit and cannot be saved.`);
    this.name = 'TooLargeError';
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve((r.result as string).slice((r.result as string).indexOf(',') + 1));
      r.onerror = () => reject(new Error('Could not read the file. It may have been moved or deleted.'));
      r.readAsDataURL(blob);
    });
  }
  return Buffer.from(await blob.arrayBuffer()).toString('base64');
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, stop: AbortController): Promise<void> {
  let next = 0;
  let failure: { e: unknown } | undefined;
  const run = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failure ??= { e };
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  if (failure) throw failure.e;
}

/**
 * Saves files as one atomic commit. Large files go to a release first; if anything fails or is
 * cancelled before the ref update, the release (and tag) is deleted, so nothing is left behind.
 */
export async function saveFiles(client: GitHubClient, branch: string, input: SaveInput, o: SaveOptions = {}): Promise<SaveResult> {
  const limits = o.limits ?? DEFAULT_LIMITS;
  const emit = o.onProgress ?? (() => {});
  const hasher: Hasher = o.hasher ?? ((f, git, p) => hashBlob(f, { git, onProgress: p }));

  const ctl = new AbortController();
  if (o.signal?.aborted) ctl.abort();
  o.signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  const signal = ctl.signal;

  const normalized = input.files.map((f) => normalizePath(f.path));
  if (!normalized.length || normalized.some((p) => !p)) throw new Error('No files selected.');
  const withGit = normalized.filter(hasGitComponent);
  if (withGit.length) throw new Error(`Git cannot store paths inside a ".git" folder (e.g. "${withGit[0]}"). Exclude them and try again.`);
  const paths = dedupePaths(normalized);
  const files = input.files.map((f, i) => ({ file: f.file, path: paths[i], kind: classify(f.file.size, limits) }));
  const tooBig = files.filter((f) => f.kind === 'too-large').map((f) => f.path);
  if (tooBig.length) throw new TooLargeError(tooBig, limits.fileMax);

  const id = newSaveId(o.now);
  const tag = releaseTag(id);
  const totalBytes = files.reduce((s, f) => s + f.file.size, 0);
  let createdRelease = false;

  const progress = (bytesDone: number, filesDone: number) =>
    emit({ type: 'overall', bytesDone, bytesTotal: totalBytes, filesDone, filesTotal: files.length });

  try {
    // 1. hash
    emit({ type: 'phase', phase: 'hashing' });
    const entries: ManifestFile[] = new Array(files.length);
    let hashedBytes = 0;
    let hashedFiles = 0;
    progress(0, 0);
    await pool(
      files.map((f, i) => ({ f, i })),
      2,
      async ({ f, i }) => {
        const git = f.kind === 'blob';
        const r = await hasher(f.file, git, (fr) => emit({ type: 'file', path: f.path, fraction: fr }));
        entries[i] = { path: f.path, size: f.file.size, sha256: r.sha256, storage: f.kind as 'blob' | 'release', ...(git ? { gitSha: r.gitSha } : {}) };
        hashedBytes += f.file.size;
        progress(hashedBytes, ++hashedFiles);
      },
      ctl,
    );

    // 2. upload
    emit({ type: 'phase', phase: 'uploading' });
    const head = await client.getHead(branch, signal);
    let existing = new Set<string>();
    const tree = await client.getTree(head.treeSha, true, signal);
    if (!tree.truncated) existing = new Set(tree.tree.filter((t) => t.type === 'blob').map((t) => t.sha));

    let doneBytes = 0;
    let doneFiles = 0;
    progress(0, 0);
    const finish = (path: string, size: number) => {
      emit({ type: 'file', path, fraction: 1 });
      doneBytes += size;
      progress(doneBytes, ++doneFiles);
    };

    const releaseEntries = entries.filter((e) => e.storage === 'release');
    if (releaseEntries.length) {
      const rel = await client.createRelease(tag, `Save ${input.name || id}`, branch, signal);
      createdRelease = true;
      for (const [n, e] of releaseEntries.entries()) {
        const file = files.find((f) => f.path === e.path)!.file;
        const asset = await client.uploadAsset(rel.id, `${n + 1}-${e.sha256.slice(0, 12)}-${safeFileName(basename(e.path))}`, file, {
          signal,
          onProgress: (fr) => emit({ type: 'file', path: e.path, fraction: fr }),
        });
        e.assetId = asset.id;
        e.assetName = asset.name;
        finish(e.path, e.size);
      }
    }

    const blobEntries = entries.filter((e) => e.storage === 'blob');
    const seen = new Set(existing);
    let uploadedBlobs = 0;
    const toUpload: ManifestFile[] = [];
    for (const e of blobEntries) {
      if (seen.has(e.gitSha!)) finish(e.path, e.size); // dedup: already in the repo (or earlier in this save)
      else {
        seen.add(e.gitSha!);
        toUpload.push(e);
      }
    }
    await pool(
      toUpload,
      4,
      async (e) => {
        const file = files.find((f) => f.path === e.path)!.file;
        const sha = await client.createBlob(await blobToBase64(file), signal);
        if (sha !== e.gitSha) throw new Error(`GitHub computed a different blob id for "${e.path}"; refusing to continue.`);
        uploadedBlobs++;
        finish(e.path, e.size);
      },
      ctl,
    );

    // 3. one atomic commit
    emit({ type: 'phase', phase: 'committing' });
    const manifest = buildManifest({
      id,
      name: input.name || id,
      tags: input.tags,
      note: input.note,
      files: entries,
      device: input.device,
      now: o.now,
      releaseTag: releaseEntries.length ? tag : undefined,
    });
    const commitSha = await commitAtomic(client, {
      branch,
      signal,
      message: `Save "${manifest.name}" (${manifest.files.length} files, ${formatBytes(manifest.totalSize)})`,
      prepare: async (h) => {
        const index = parseIndex(await client.getTextAt(INDEX_PATH, h.commitSha, signal));
        return [
          ...blobEntries.map((e) => fileEntry(repoFilePath(id, e.path), e.gitSha!)),
          textEntry(`saves/${id}/manifest.json`, toJson(manifest)),
          textEntry(INDEX_PATH, toJson(upsertSummary(index, summarize(manifest)))),
        ];
      },
    });

    return {
      id,
      commitSha,
      fileCount: manifest.files.length,
      totalSize: manifest.totalSize,
      uploadedBlobs,
      reusedBlobs: blobEntries.length - uploadedBlobs,
      releaseFiles: releaseEntries.length,
    };
  } catch (e) {
    if (createdRelease) await client.deleteReleaseByTag(tag).catch(() => {});
    throw e;
  }
}
