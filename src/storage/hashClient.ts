import { hashBlob, type HashResult } from './hash';

export type Hasher = (file: Blob, git: boolean, onProgress?: (f: number) => void) => Promise<HashResult>;

interface Pending {
  resolve: (r: HashResult) => void;
  reject: (e: Error) => void;
  onProgress?: (f: number) => void;
}

/** Hashes in a Web Worker so the UI stays responsive; falls back to the main thread if workers are unavailable. */
export function createWorkerHasher(): Hasher & { terminate(): void } {
  let worker: Worker | null = null;
  let broken = typeof Worker === 'undefined';
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (msg: string) => {
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
  };

  const get = (): Worker | null => {
    if (broken) return null;
    if (!worker) {
      try {
        worker = new Worker(new URL('../workers/hash.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent) => {
          const m = e.data as { id: number; ok?: boolean; progress?: number; error?: string } & HashResult;
          const p = pending.get(m.id);
          if (!p) return;
          if (m.progress !== undefined) return p.onProgress?.(m.progress);
          pending.delete(m.id);
          if (m.ok) p.resolve({ sha256: m.sha256, gitSha: m.gitSha });
          else p.reject(new Error(m.error ?? 'Hashing failed'));
        };
        worker.onerror = () => {
          broken = true;
          worker = null;
          failAll('Hash worker crashed');
        };
      } catch {
        broken = true;
        return null;
      }
    }
    return worker;
  };

  const hasher = (async (file, git, onProgress) => {
    const w = get();
    if (!w) return hashBlob(file, { git, onProgress });
    const id = nextId++;
    try {
      return await new Promise<HashResult>((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        w.postMessage({ id, file, git });
      });
    } catch (e) {
      // worker died: retry on the main thread
      if (broken) return hashBlob(file, { git, onProgress });
      throw e;
    }
  }) as Hasher & { terminate(): void };
  hasher.terminate = () => {
    worker?.terminate();
    worker = null;
  };
  return hasher;
}
