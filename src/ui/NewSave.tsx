import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { GitHubError, describeError } from '../api/github';
import { compilePatterns, isExcluded } from '../storage/excludes';
import { createWorkerHasher } from '../storage/hashClient';
import { classify, describeDevice } from '../storage/manifest';
import { buildTree, formatBytes, hasGitComponent, normalizePath } from '../storage/paths';
import { saveFiles, type ProgressEvent, type SaveResult } from '../storage/saveService';
import { DEFAULT_LIMITS } from '../storage/types';
import { useApp } from './app';
import { FileTree } from './FileTree';
import { defaultName, fromDataTransfer, fromInput, type Picked } from './collect';

interface Row extends Picked {
  size: number;
}

const canPickFolder = () =>
  typeof document !== 'undefined' &&
  'webkitdirectory' in document.createElement('input') &&
  !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

interface Prog {
  phase: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  active: Record<string, number>;
}
const idleProg: Prog = { phase: '', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, active: {} };

export function NewSave() {
  const { client, branch, settings, updateSettings } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [excludeText, setExcludeText] = useState(settings.excludes.join('\n'));
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<Prog>(idleProg);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SaveResult | null>(null);
  const progRef = useRef<Prog>(idleProg);
  const abortRef = useRef<AbortController | null>(null);
  const folderOk = useMemo(canPickFolder, []);

  // Throttle progress rendering.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setProg({ ...progRef.current, active: { ...progRef.current.active } }), 120);
    return () => clearInterval(t);
  }, [busy]);

  const matchers = useMemo(() => compilePatterns(excludeText.split('\n')), [excludeText]);
  const patternExcluded = (p: string) => isExcluded(p, matchers) || hasGitComponent(p);
  const included = rows.filter((r) => !patternExcluded(r.path) && !unchecked.has(r.path));
  const totalBytes = included.reduce((s, r) => s + r.size, 0);
  const releaseCount = included.filter((r) => classify(r.size) === 'release').length;
  const tooBig = included.filter((r) => classify(r.size) === 'too-large');
  const tree = useMemo(() => buildTree(rows), [rows]);
  const selected = useMemo(() => new Set(included.map((r) => r.path)), [rows, unchecked, matchers]);

  function add(picked: Picked[]) {
    const clean: Row[] = [];
    for (const p of picked) {
      try {
        const path = normalizePath(p.path);
        if (path) clean.push({ file: p.file, path, size: p.file.size });
      } catch {
        /* skip unsafe */
      }
    }
    setResult(null);
    setError('');
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.path));
      const next = [...prev, ...clean.filter((r) => !seen.has(r.path))];
      if (!name) setName(defaultName(next));
      return next;
    });
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer) add(await fromDataTransfer(e.dataTransfer));
  }

  function onProgress(e: ProgressEvent) {
    const p = progRef.current;
    if (e.type === 'phase') progRef.current = { ...p, phase: e.phase, active: {} };
    else if (e.type === 'overall') progRef.current = { ...p, ...e, type: undefined } as Prog;
    else {
      if (e.fraction >= 1) delete p.active[e.path];
      else p.active[e.path] = e.fraction;
    }
  }

  async function start() {
    setError('');
    setResult(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    progRef.current = { ...idleProg };
    setProg(progRef.current);
    setBusy(true);
    const hasher = createWorkerHasher();
    try {
      const info = await client!.getRepo(ctl.signal);
      if (!info.private && settings.publicConfirmed !== info.full_name) {
        throw new Error(`${info.full_name} is public. Open Settings and either switch to a private repo or explicitly confirm.`);
      }
      if (!settings.branch) updateSettings({ branch: info.default_branch });
      const r = await saveFiles(
        client!,
        settings.branch || info.default_branch || branch,
        { name, tags, note, device: describeDevice(navigator.userAgent), files: included.map((i) => ({ file: i.file, path: i.path })) },
        { signal: ctl.signal, onProgress, hasher },
      );
      setResult(r);
      setRows([]);
      setUnchecked(new Set());
      setName('');
      setTags('');
      setNote('');
    } catch (e) {
      const cancelled = e instanceof GitHubError && e.kind === 'abort';
      setError(cancelled ? 'Cancelled. Nothing was saved.' : `${describeError(e)} Nothing was committed.`);
    } finally {
      hasher.terminate();
      setBusy(false);
      abortRef.current = null;
    }
  }

  const pct = prog.bytesTotal ? Math.round((prog.bytesDone / prog.bytesTotal) * 100) : 0;
  const phaseLabel = { hashing: 'Hashing files', uploading: 'Uploading', committing: 'Creating commit', '': 'Starting' }[prog.phase as 'hashing'] ?? prog.phase;

  return (
    <section>
      <h1>New save</h1>

      {result && (
        <div class="card success" role="status">
          <h2>✔ Saved</h2>
          <ul>
            <li>{result.fileCount} files, {formatBytes(result.totalSize)} in a single commit (<code>{result.commitSha.slice(0, 7)}</code>)</li>
            <li>{result.uploadedBlobs} uploaded, {result.reusedBlobs} already in the repo (not re-uploaded){result.releaseFiles ? `, ${result.releaseFiles} large file(s) stored as release assets` : ''}</li>
          </ul>
          <a class="button primary" href={`#/save/${result.id}`}>Open save</a>
        </div>
      )}

      {!busy && (
        <div
          class={`drop ${dragging ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p><strong>Drag files or folders here</strong></p>
          <div class="actions">
            <label class="button">
              Pick files
              <input type="file" multiple hidden data-testid="pick-files" onChange={(e) => { add(fromInput((e.target as HTMLInputElement).files)); (e.target as HTMLInputElement).value = ''; }} />
            </label>
            {folderOk ? (
              <label class="button">
                Pick folder
                <input type="file" hidden data-testid="pick-folder" {...{ webkitdirectory: true }} onChange={(e) => { add(fromInput((e.target as HTMLInputElement).files)); (e.target as HTMLInputElement).value = ''; }} />
              </label>
            ) : (
              <span class="muted">Folder picking isn't available on this device; choose files instead.</span>
            )}
          </div>
        </div>
      )}

      {rows.length > 0 && !busy && (
        <>
          <h2>Review</h2>
          <p>
            <strong>{included.length}</strong> of {rows.length} files selected · <strong>{formatBytes(totalBytes)}</strong>
            {releaseCount > 0 && <> · {releaseCount} will use release storage (over {formatBytes(DEFAULT_LIMITS.blobMax)})</>}
          </p>
          {tooBig.length > 0 && (
            <p role="alert" class="notice error">
              {tooBig.length} file(s) exceed the {formatBytes(DEFAULT_LIMITS.fileMax)} limit (e.g. {tooBig[0].path}). Uncheck them to continue.
            </p>
          )}
          <details>
            <summary>Exclude patterns</summary>
            <textarea rows={4} aria-label="Exclude patterns" value={excludeText} onInput={(e) => setExcludeText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
            <p class="muted">One per line. <code>name/</code> = folder, <code>*.log</code> = glob. Files inside <code>.git</code> can never be stored.</p>
          </details>
          <FileTree
            nodes={tree}
            selected={selected}
            isDisabled={(r) => patternExcluded(r.path)}
            onToggle={(paths, on) =>
              setUnchecked((u) => {
                const n = new Set(u);
                paths.forEach((p) => (on ? n.delete(p) : n.add(p)));
                return n;
              })
            }
            leaf={(r) => (
              <span class="muted meta">
                {patternExcluded(r.path) ? 'excluded' : classify(r.size) === 'release' ? `${formatBytes(r.size)} · release` : formatBytes(r.size)}
              </span>
            )}
          />
          <form class="card" onSubmit={(e) => { e.preventDefault(); void start(); }}>
            <label>Name<input required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label>Tags (comma separated)<input value={tags} onInput={(e) => setTags((e.target as HTMLInputElement).value)} placeholder="work, taxes, 2024" /></label>
            <label>Note<textarea rows={3} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} /></label>
            <div class="actions">
              <button type="submit" class="primary" disabled={included.length === 0 || tooBig.length > 0 || !name.trim()}>
                Save {included.length} file{included.length === 1 ? '' : 's'} ({formatBytes(totalBytes)})
              </button>
              <button type="button" onClick={() => { setRows([]); setUnchecked(new Set()); setName(''); }}>Clear</button>
            </div>
          </form>
        </>
      )}

      {busy && (
        <div class="card" aria-live="polite">
          <h2>{phaseLabel}…</h2>
          <label>
            Overall: {prog.filesDone}/{prog.filesTotal} files · {formatBytes(prog.bytesDone)} of {formatBytes(prog.bytesTotal)} ({pct}%)
            <progress max={100} value={pct} />
          </label>
          {Object.entries(prog.active).slice(0, 6).map(([p, f]) => (
            <label key={p} class="small">
              <span class="name">{p}</span>
              <progress max={100} value={Math.round(f * 100)} />
            </label>
          ))}
          <button type="button" onClick={() => abortRef.current?.abort()}>Cancel</button>
          <p class="muted">Nothing is committed unless the whole save succeeds.</p>
        </div>
      )}

      {error && <p role="alert" class="notice error">{error}</p>}
    </section>
  );
}
