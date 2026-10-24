/** Normalises a user-supplied relative path: '/'-separated, NFC, no empty/'.' segments; rejects '..'. */
export function normalizePath(p: string): string {
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..')) throw new Error(`Unsafe path: ${p}`);
  return parts.join('/').normalize('NFC');
}

/** Git refuses any path containing a ".git" component, so such files can never be stored. */
export function hasGitComponent(p: string): boolean {
  return p.split('/').some((s) => s.toLowerCase() === '.git');
}

export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Makes paths unique by appending " (2)", " (3)"... before the extension. */
export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.map((p) => {
    let out = p;
    for (let n = 2; seen.has(out); n++) {
      const dir = dirname(p);
      const base = basename(p);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      out = `${dir ? dir + '/' : ''}${stem} (${n})${ext}`;
    }
    seen.add(out);
    return out;
  });
}

export const repoFilePath = (id: string, rel: string) => `saves/${id}/files/${rel}`;

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'download';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export interface TreeNode<T> {
  name: string;
  path: string;
  children: TreeNode<T>[];
  item?: T;
}

/** Builds a folder tree (folders first, then name order) from items keyed by path. */
export function buildTree<T extends { path: string }>(items: T[]): TreeNode<T>[] {
  const root: TreeNode<T> = { name: '', path: '', children: [] };
  for (const item of items) {
    let node = root;
    const parts = item.path.split('/');
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && (last ? c.item : !c.item));
      if (!child) {
        child = { name: part, path, children: [] };
        node.children.push(child);
      }
      if (last) child.item = item;
      node = child;
    });
  }
  const sort = (n: TreeNode<T>) => {
    n.children.sort((a, b) => Number(!!a.item) - Number(!!b.item) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export function leafPaths<T>(node: TreeNode<T>): string[] {
  return node.item ? [node.path] : node.children.flatMap(leafPaths);
}
