import { hashBlob } from '../storage/hash';

export interface HashRequest {
  id: number;
  file: Blob;
  git: boolean;
}

self.onmessage = async (e: MessageEvent<HashRequest>) => {
  const { id, file, git } = e.data;
  try {
    const r = await hashBlob(file, { git, onProgress: (f) => self.postMessage({ id, progress: f }) });
    self.postMessage({ id, ok: true, ...r });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
