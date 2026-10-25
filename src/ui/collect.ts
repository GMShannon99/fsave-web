export interface Picked {
  file: File;
  path: string;
}

/** Files from <input type=file> (with or without webkitdirectory). */
export function fromInput(files: FileList | null): Picked[] {
  return Array.from(files ?? [], (file) => ({ file, path: file.webkitRelativePath || file.name }));
}

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
};

async function walk(entry: FsEntry, prefix: string, out: Picked[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader!();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Files and whole folders from a drop event. */
export async function fromDataTransfer(dt: DataTransfer): Promise<Picked[]> {
  // Entries must be grabbed synchronously, before any await.
  const entries = Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => ({ entry: (i as DataTransferItem & { webkitGetAsEntry(): FsEntry | null }).webkitGetAsEntry(), file: i.getAsFile() }));
  const out: Picked[] = [];
  for (const { entry, file } of entries) {
    if (entry) await walk(entry, '', out);
    else if (file) out.push({ file, path: file.name });
  }
  return out;
}

export function defaultName(items: Picked[]): string {
  if (!items.length) return '';
  const roots = new Set(items.map((i) => i.path.split('/')[0]));
  const hasFolder = items.some((i) => i.path.includes('/'));
  if (hasFolder && roots.size === 1) return [...roots][0];
  return items.length === 1 ? items[0].path : `${items.length} files`;
}

/** Folder picking works on desktop browsers only (not phones/tablets). */
export const canPickFolder = () =>
  typeof document !== 'undefined' &&
  'webkitdirectory' in document.createElement('input') &&
  !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** A friendly default name: what was picked, plus today's date. */
export function suggestName(items: Picked[], now = new Date()): string {
  const base = defaultName(items);
  if (!base) return '';
  return `${base} - ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`;
}
