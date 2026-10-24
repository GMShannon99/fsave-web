export type StorageKind = 'blob' | 'release';

export interface ManifestFile {
  /** Path relative to the save root, '/'-separated, NFC-normalised. */
  path: string;
  size: number;
  sha256: string;
  storage: StorageKind;
  /** Git blob SHA (blob storage only). */
  gitSha?: string;
  assetId?: number;
  assetName?: string;
}

export interface Manifest {
  version: 1;
  id: string;
  name: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt?: string;
  source: { device: string };
  totalSize: number;
  releaseTag?: string;
  files: ManifestFile[];
}

export interface SaveSummary {
  id: string;
  name: string;
  tags: string[];
  note: string;
  createdAt: string;
  fileCount: number;
  totalSize: number;
  hasRelease: boolean;
  /** A capped sample of file paths, used for filename search. */
  paths: string[];
  pathsTruncated?: boolean;
}

export interface SaveIndex {
  version: 1;
  saves: SaveSummary[];
}

export interface Limits {
  /** Files above this go to release assets. */
  blobMax: number;
  /** Files above this are rejected. */
  fileMax: number;
}

export const MB = 1024 * 1024;
export const DEFAULT_LIMITS: Limits = { blobMax: 50 * MB, fileMax: 2 * 1024 * MB };
export const DEFAULT_EXCLUDES = ['.git/', 'node_modules/', '.DS_Store', 'Thumbs.db'];
export const INDEX_PATH = 'index.json';
export const manifestPath = (id: string) => `saves/${id}/manifest.json`;
export const releaseTag = (id: string) => `save-${id}`;
