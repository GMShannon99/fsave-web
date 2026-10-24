import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { leafPaths, type TreeNode } from '../storage/paths';

export interface TreeProps<T> {
  nodes: TreeNode<T>[];
  selected: Set<string>;
  isDisabled?: (item: T) => boolean;
  onToggle(paths: string[], on: boolean): void;
  leaf(item: T): ComponentChildren;
}

function Check({ checked, indeterminate, disabled, label, onChange }: { checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string; onChange(on: boolean): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />;
}

function Node<T extends { path: string }>({ node, depth, p }: { node: TreeNode<T>; depth: number; p: TreeProps<T> }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.item) {
    const dis = p.isDisabled?.(node.item) ?? false;
    return (
      <li class={dis ? 'leaf disabled' : 'leaf'}>
        <div class="row">
          <Check checked={!dis && p.selected.has(node.path)} disabled={dis} label={`Select ${node.name}`} onChange={(on) => p.onToggle([node.path], on)} />
          <span class="name" title={node.path}>{node.name}</span>
          {p.leaf(node.item)}
        </div>
      </li>
    );
  }
  const all = leafPaths(node);
  const sel = all.filter((x) => p.selected.has(x));
  return (
    <li class="folder">
      <div class="row">
        <button type="button" class="twisty" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <Check checked={sel.length > 0 && sel.length === all.length} indeterminate={sel.length > 0 && sel.length < all.length} label={`Select folder ${node.name}`} onChange={(on) => p.onToggle(all, on)} />
        <span class="name">📁 {node.name}</span>
        <span class="muted">{all.length} file{all.length === 1 ? '' : 's'}</span>
      </div>
      {open && (
        <ul>
          {node.children.map((c) => (
            <Node key={c.name + (c.item ? '#' : '/')} node={c} depth={depth + 1} p={p} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FileTree<T extends { path: string }>(p: TreeProps<T>) {
  return (
    <ul class="tree">
      {p.nodes.map((n) => (
        <Node key={n.name + (n.item ? '#' : '/')} node={n} depth={0} p={p} />
      ))}
    </ul>
  );
}
