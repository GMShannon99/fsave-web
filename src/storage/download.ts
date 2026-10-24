import JSZip from 'jszip';
import { GitHubClient } from '../api/github';
import { sha256Hex } from './hash';
import type { Manifest, ManifestFile } from './types';

export const ZIP_WARN_BYTES = 1024 * 1024 * 1024;

export interface Fetched {
  data: ArrayBuffer;
  /** True when the SHA-256 of the downloaded bytes matches the manifest. */
  verified: boolean;
}

export async function fetchVerified(client: GitHubClient, f: ManifestFile, signal?: AbortSignal): Promise<Fetched> {
  const data = f.storage === 'blob' ? await client.getBlobBytes(f.gitSha!, signal) : await client.downloadAsset(f.assetId!, signal);
  return { data, verified: (await sha256Hex(data)) === f.sha256 };
}

export async function buildZip(
  client: GitHubClient,
  manifest: Manifest,
  files: ManifestFile[],
  o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ blob: Blob; failed: string[] }> {
  const zip = new JSZip();
  const failed: string[] = [];
  const date = new Date(manifest.createdAt);
  let next = 0;
  let done = 0;
  const run = async () => {
    while (next < files.length) {
      const f = files[next++];
      const r = await fetchVerified(client, f, o.signal);
      if (!r.verified) failed.push(f.path);
      zip.file(f.path, r.data, { binary: true, date });
      o.onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, run));
  if (failed.length) {
    zip.file(
      'FSAVE-VERIFICATION-FAILED.txt',
      `These files did not match their recorded SHA-256 and may be corrupted:\n\n${failed.join('\n')}\n`,
    );
  }
  const blob = await zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 1 } });
  return { blob, failed };
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
