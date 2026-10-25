import { useEffect, useMemo, useState } from 'preact/hooks';
import { describeError } from '../api/github';
import { matchesQuery } from '../storage/manifest';
import { formatBytes } from '../storage/paths';
import { loadIndex } from '../storage/repoOps';
import type { SaveSummary } from '../storage/types';
import { useApp } from './app';
import { canPickFolder, fromInput } from './collect';
import { DOWNLOAD_STARTED, bigWarning, downloadWholeSave } from './downloadSave';
import { setPending } from './pending';
import { applyRecent } from './recent';

type Sort = 'date-desc' | 'date-asc' | 'size-desc' | 'size-asc';
/** The search box and sort menu only appear once the list is long enough to need them. */
const SEARCH_FROM = 6;

export function Browse() {
  const { client, branch } = useApp();
  const [saves, setSaves] = useState<SaveSummary[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('date-desc');
  const [nonce, setNonce] = useState(0);
  const [busyId, setBusyId] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [flash] = useState(() => {
    const f = sessionStorage.getItem('fsave.flash') ?? '';
    sessionStorage.removeItem('fsave.flash');
    return f;
  });
  const folderOk = useMemo(canPickFolder, []);

  useEffect(() => {
    const ctl = new AbortController();
    setSaves(null);
    setError('');
    loadIndex(client!, branch, ctl.signal).then(
      (i) => setSaves(applyRecent(i.saves)),
      (e) => !ctl.signal.aborted && setError(describeError(e)),
    );
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

  function pick(e: Event) {
    const input = e.target as HTMLInputElement;
    const picked = fromInput(input.files);
    input.value = '';
    if (!picked.length) return;
    setPending(picked);
    location.hash = '#/new';
  }

  async function download(s: SaveSummary) {
    setStatus(null);
    setBusyId(s.id);
    try {
      const r = await downloadWholeSave(client!, branch, s.id, {
        confirmBig: (bytes) => confirm(bigWarning(bytes)),
        onProgress: (d, t) => setStatus({ kind: 'ok', text: `Getting “${s.name}” ready… ${d} of ${t} files` }),
      });
      if (r.cancelled) setStatus(null);
      else if (r.damaged.length) setStatus({ kind: 'error', text: `⚠ ${r.damaged.length} file(s) in “${s.name}” may be damaged. Everything was downloaded anyway; a note inside the zip lists them.` });
      else setStatus({ kind: 'ok', text: DOWNLOAD_STARTED });
    } catch (e) {
      setStatus({ kind: 'error', text: describeError(e) });
    } finally {
      setBusyId('');
    }
  }

  const showTools = (saves?.length ?? 0) >= SEARCH_FROM;

  return (
    <section>
      <h1>My files</h1>
      <div class="actions">
        <label class="button primary big">
          ⬆ Upload files
          <input type="file" multiple hidden data-testid="home-pick-files" onChange={pick} />
        </label>
        {folderOk && (
          <label class="button big">
            📁 Upload a folder
            <input type="file" hidden data-testid="home-pick-folder" {...{ webkitdirectory: true }} onChange={pick} />
          </label>
        )}
      </div>
      {saves && saves.length > 0 && <p class="hint">Click a save's name to see its files.</p>}

      {showTools && (
        <div class="toolbar">
          <input type="search" placeholder="Search by name or file name…" aria-label="Search your files" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <select aria-label="Sort" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as Sort)}>
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="size-desc">Largest first</option>
            <option value="size-asc">Smallest first</option>
          </select>
        </div>
      )}
      {flash && <p role="status" class="notice ok">{flash}</p>}
      {status && <p role={status.kind === 'error' ? 'alert' : 'status'} class={`notice ${status.kind}`}>{status.text}</p>}
      {error && (
        <p role="alert" class="notice error">
          {error} <button type="button" class="link" onClick={() => setNonce(nonce + 1)}>Try again</button>
        </p>
      )}
      {!error && saves === null && <p class="muted" role="status">Loading your files…</p>}
      {saves?.length === 0 && (
        <div class="empty">
          <p><strong>Nothing saved yet.</strong></p>
          <p>Click <strong>Upload files</strong> to save your first files.</p>
        </div>
      )}
      {saves && saves.length > 0 && shown.length === 0 && <p class="empty">Nothing matches “{q}”.</p>}
      <ul class="cards">
        {shown.map((s) => (
          <li key={s.id} class="card save-row">
            <div class="save-info">
              <a class="save-name" href={`#/save/${s.id}`}><h2>{s.name}</h2></a>
              <p class="muted">
                {new Date(s.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · {s.fileCount} file{s.fileCount === 1 ? '' : 's'} · {formatBytes(s.totalSize)}
              </p>
              {s.tags.length > 0 && <p class="tags">{s.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</p>}
            </div>
            <button type="button" class="primary" disabled={!!busyId} aria-label={`Download ${s.name}`} onClick={() => download(s)}>
              {busyId === s.id ? 'Preparing…' : '⬇ Download'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
