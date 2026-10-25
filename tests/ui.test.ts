import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/api/github';
import type { SaveSummary } from '../src/storage/types';
import { suggestName } from '../src/ui/collect';
import { applyRecent, noteDeleted, noteSaved, resetRecent } from '../src/ui/recent';
import { takePending, setPending } from '../src/ui/pending';
import { mountFake } from './support/harness';

const save = (id: string, createdAt: string, extra: Partial<SaveSummary> = {}): SaveSummary => ({
  id, name: id, tags: [], note: '', createdAt, fileCount: 1, totalSize: 1, hasRelease: false, paths: [], ...extra,
});
const pick = (...paths: string[]) => paths.map((path) => ({ path, file: new File(['x'], path.split('/').pop()!) }));

describe('recent saves/deletes keep the list right immediately', () => {
  beforeEach(resetRecent);

  it('shows a save that the (stale) index does not have yet', () => {
    noteSaved(save('new', '2026-10-25T10:00:00Z'));
    const list = applyRecent([save('old', '2026-10-24T10:00:00Z')]);
    expect(list.map((s) => s.id)).toEqual(['new', 'old']);
  });
  it('does not duplicate a save the index already has, and prefers the index copy', () => {
    noteSaved(save('a', '2026-10-25T10:00:00Z', { name: 'local' }));
    const list = applyRecent([save('a', '2026-10-25T10:00:00Z', { name: 'from-index' })]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('from-index');
  });
  it('hides a deleted save even if the stale index still lists it', () => {
    noteDeleted('gone');
    expect(applyRecent([save('gone', '2026-10-24T10:00:00Z'), save('kept', '2026-10-23T10:00:00Z')]).map((s) => s.id)).toEqual(['kept']);
  });
  it('a delete cancels a remembered save', () => {
    noteSaved(save('x', '2026-10-25T10:00:00Z'));
    noteDeleted('x');
    expect(applyRecent([])).toEqual([]);
  });
  it('forgets after ten minutes', () => {
    noteDeleted('gone');
    expect(applyRecent([save('gone', '2026-10-24T10:00:00Z')], Date.now() + 11 * 60_000).map((s) => s.id)).toEqual(['gone']);
  });
});

describe('friendly upload names', () => {
  const day = new Date(2026, 9, 25);
  it('uses the file name plus the date for a single file', () => {
    expect(suggestName(pick('report.pdf'), day)).toBe('report.pdf - Oct 25, 2026');
  });
  it('uses the folder name for a folder', () => {
    expect(suggestName(pick('My Project/a.txt', 'My Project/sub/b.txt'), day)).toBe('My Project - Oct 25, 2026');
  });
  it('counts several loose files', () => {
    expect(suggestName(pick('a.txt', 'b.txt'), day)).toBe('2 files - Oct 25, 2026');
  });
  it('is empty with nothing picked', () => {
    expect(suggestName([], day)).toBe('');
  });
});

describe('files chosen on the home screen are handed over once', () => {
  it('returns them once, then nothing', () => {
    setPending(pick('a.txt'));
    expect(takePending()).toHaveLength(1);
    expect(takePending()).toBeNull();
  });
});

describe('client never reuses a cached GitHub answer', () => {
  it('sends cache: no-store on every request', async () => {
    const { fake } = mountFake();
    const modes: Array<RequestCache | undefined> = [];
    const client = new GitHubClient({
      token: fake.token,
      owner: fake.owner,
      repo: fake.repo,
      fetchImpl: ((url: string, init: RequestInit) => {
        modes.push(init.cache);
        return fetch(url, init);
      }) as typeof fetch,
    });
    await client.getRepo();
    await client.getHead('main');
    expect(modes.length).toBeGreaterThan(1);
    expect(modes.every((m) => m === 'no-store')).toBe(true);
  });
});
