import type { SaveSummary } from '../storage/types';

// Remembers saves/deletes made in this browser so the list is right immediately,
// even if GitHub briefly returns an older copy of the list.
const TTL_MS = 10 * 60_000;
const added = new Map<string, { s: SaveSummary; at: number }>();
const removed = new Map<string, number>();

export const noteSaved = (s: SaveSummary) => void added.set(s.id, { s, at: Date.now() });
export const noteDeleted = (id: string) => {
  removed.set(id, Date.now());
  added.delete(id);
};

export function applyRecent(list: SaveSummary[], now = Date.now()): SaveSummary[] {
  for (const [k, t] of removed) if (now - t > TTL_MS) removed.delete(k);
  for (const [k, v] of added) if (now - v.at > TTL_MS) added.delete(k);
  const have = new Set(list.map((s) => s.id));
  const merged = [...list.filter((s) => !removed.has(s.id)), ...[...added.values()].map((v) => v.s).filter((s) => !have.has(s.id) && !removed.has(s.id))];
  return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resetRecent() {
  added.clear();
  removed.clear();
}
