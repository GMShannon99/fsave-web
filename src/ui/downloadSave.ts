import type { GitHubClient } from '../api/github';
import { ZIP_WARN_BYTES, buildZip, triggerDownload } from '../storage/download';
import { formatBytes, safeFileName } from '../storage/paths';
import { loadManifest } from '../storage/repoOps';

export const DOWNLOAD_STARTED = '✓ Downloading — check your Downloads folder.';

/** Downloads a whole save as a zip. Returns how many files failed their integrity check. */
export async function downloadWholeSave(
  client: GitHubClient,
  branch: string,
  id: string,
  o: { onProgress?: (done: number, total: number) => void; confirmBig?: (bytes: number) => boolean } = {},
): Promise<{ cancelled: boolean; damaged: string[] }> {
  const m = await loadManifest(client, branch, id);
  if (m.totalSize > ZIP_WARN_BYTES && o.confirmBig && !o.confirmBig(m.totalSize)) return { cancelled: true, damaged: [] };
  const { blob, failed } = await buildZip(client, m, m.files, { onProgress: o.onProgress });
  triggerDownload(blob, `${safeFileName(m.name)}.zip`);
  return { cancelled: false, damaged: failed };
}

export const bigWarning = (bytes: number) => `This download is ${formatBytes(bytes)}. It is prepared in your browser and may be slow or fail on a small computer. Continue?`;
