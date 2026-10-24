import { useEffect, useMemo, useState } from 'preact/hooks';
import { describeError } from '../api/github';
import { matchesQuery } from '../storage/manifest';
import { formatBytes } from '../storage/paths';
import { loadIndex } from '../storage/repoOps';
import type { SaveSummary } from '../storage/types';
import { useApp } from './app';

type Sort = 'date-desc' | 'date-asc' | 'size-desc' | 'size-asc';

export function Browse() {
  const { client, branch } = useApp();
  const [saves, setSaves] = useState<SaveSummary[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('date-desc');
  const [nonce, setNonce] = useState(0);
  const [flash] = useState(() => {
    const f = sessionStorage.getItem('fsave.flash') ?? '';
    sessionStorage.removeItem('fsave.flash');
    return f;
  });

  useEffect(() => {
    const ctl = new AbortController();
    setSaves(null);
    setError('');
    loadIndex(client!, branch, ctl.signal).then((i) => setSaves(i.saves), (e) => !ctl.signal.aborted && setError(describeError(e)));
    return () => ctl.abort();
  }, [client, branch, nonce]);

  const shown = useMemo(() => {
    const list = (saves ?? []).filter((s) => matchesQuery(s, q));
    const by: Record<Sort, (a: SaveSummary, b: SaveSummary) => number> = {
      'date-desc': (a, b) => b.createdAt.localeCompare(a.createdAt),
      'date-asc': (a, b) => a.createdAt.localeCompare(b.createdAt),
      'size-desc': (a, b) => b.totalSize - a.totalSize,
      'size-asc': (a, b) => a.totalSize - b.totalSize,
    };
    return list.sort(by[sort]);
  }, [saves, q, sort]);

  return (
    <section>
      <h1>Saves</h1>
      <div class="toolbar">
        <input type="search" placeholder="Search name, tag or file name…" aria-label="Search saves" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <select aria-label="Sort" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
          <option value="date-desc">Newest first</option>
          <option value="date-asc">Oldest first</option>
          <option value="size-desc">Largest first</option>
          <option value="size-asc">Smallest first</option>
        </select>
        <button type="button" onClick={() => setNonce(nonce + 1)}>Refresh</button>
      </div>
      {flash && <p role="status" class="notice ok">{flash}</p>}
      {error && <p role="alert" class="notice error">{error}</p>}
      {!error && saves === null && <p class="muted" role="status">Loading…</p>}
      {saves?.length === 0 && (
        <div class="empty">
          <p><strong>Nothing saved yet.</strong></p>
          <p>Pick some files or a folder and they'll show up here, from any device.</p>
          <a class="button primary" href="#/new">Create your first save</a>
        </div>
      )}
      {saves && saves.length > 0 && shown.length === 0 && <p class="empty">No saves match “{q}”.</p>}
      <ul class="cards">
        {shown.map((s) => (
          <li key={s.id}>
            <a class="card save" href={`#/save/${s.id}`}>
              <h2>{s.name}</h2>
              <p class="muted">
                {new Date(s.createdAt).toLocaleString()} · {s.fileCount} file{s.fileCount === 1 ? '' : 's'} · {formatBytes(s.totalSize)}
                {s.hasRelease ? ' · large files' : ''}
              </p>
              {s.tags.length > 0 && (
                <p class="tags">{s.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</p>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
