import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { GitHubError, describeError } from '../api/github';
import { compilePatterns, isExcluded } from '../storage/excludes';
import { createWorkerHasher } from '../storage/hashClient';
import { classify, describeDevice, parseTags } from '../storage/manifest';
import { buildTree, formatBytes, hasGitComponent, normalizePath } from '../storage/paths';
import { saveFiles, type ProgressEvent } from '../storage/saveService';
import { DEFAULT_LIMITS } from '../storage/types';
import { useApp } from './app';
import { FileTree } from './FileTree';
import { canPickFolder, fromDataTransfer, fromInput, suggestName, type Picked } from './collect';
import { takePending } from './pending';
import { noteSaved } from './recent';

interface Row extends Picked {
  size: number;
}

interface Prog {
  phase: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  active: Record<string, number>;
}
const idleProg: Prog = { phase: '', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, active: {} };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

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
  const [done, setDone] = useState<{ name: string; count: number; id: string } | null>(null);
  const progRef = useRef<Prog>(idleProg);
  const abortRef = useRef<AbortController | null>(null);
  const folderOk = useMemo(canPickFolder, []);

  // Throttle progress rendering.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setProg({ ...progRef.current, active: { ...progRef.current.active } }), 120);
    return () => clearInterval(t);
  }, [busy]);

  // Files already chosen on the home screen.
  useEffect(() => {
    const p = takePending();
    if (p) add(p);
  }, []);

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
    setDone(null);
    setError('');
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.path));
      const next = [...prev, ...clean.filter((r) => !seen.has(r.path))];
      setName((n) => n || suggestName(next));
      return next;
    });
  }

  function clearAll() {
    setRows([]);
    setUnchecked(new Set());
    setName('');
    setError('');
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
    setDone(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    progRef.current = { ...idleProg };
    setProg(progRef.current);
    setBusy(true);
    const hasher = createWorkerHasher();
    const saveName = name.trim();
    try {
      const info = await client!.getRepo(ctl.signal);
      if (!info.private && settings.publicConfirmed !== info.full_name) {
        throw new Error('Your storage folder is set to public, so anyone could see your files. Make it private on GitHub (or open Settings → Advanced) before uploading.');
      }
      if (!settings.branch) updateSettings({ branch: info.default_branch });
      const r = await saveFiles(
        client!,
        settings.branch || info.default_branch || branch,
        { name: saveName, tags, note, device: describeDevice(navigator.userAgent), files: included.map((i) => ({ file: i.file, path: i.path })) },
        { signal: ctl.signal, onProgress, hasher },
      );
      noteSaved({
        id: r.id,
        name: saveName,
        tags: parseTags(tags),
        note,
        createdAt: new Date().toISOString(),
        fileCount: r.fileCount,
        totalSize: r.totalSize,
        hasRelease: r.releaseFiles > 0,
        paths: [],
      });
      setDone({ name: saveName, count: r.fileCount, id: r.id });
      setRows([]);
      setUnchecked(new Set());
      setName('');
      setTags('');
      setNote('');
    } catch (e) {
      const cancelled = e instanceof GitHubError && e.kind === 'abort';
      setError(cancelled ? 'Cancelled. Nothing was uploaded.' : `${describeError(e)} Nothing was uploaded.`);
    } finally {
      hasher.terminate();
      setBusy(false);
      abortRef.current = null;
    }
  }

  const pct = prog.bytesTotal ? Math.round((prog.bytesDone / prog.bytesTotal) * 100) : 0;
  const phaseLabel = { hashing: 'Checking your files', uploading: 'Uploading', committing: 'Finishing up', '': 'Starting' }[prog.phase as 'hashing'] ?? prog.phase;
  const canUpload = included.length > 0 && tooBig.length === 0 && !!name.trim();

  const pickInputs = (
    <div class="actions">
      <label class="button primary big">
        Choose files
        <input type="file" multiple hidden data-testid="pick-files" onChange={(e) => { add(fromInput((e.target as HTMLInputElement).files)); (e.target as HTMLInputElement).value = ''; }} />
      </label>
      {folderOk ? (
        <label class="button big">
          Choose a folder
          <input type="file" hidden data-testid="pick-folder" {...{ webkitdirectory: true }} onChange={(e) => { add(fromInput((e.target as HTMLInputElement).files)); (e.target as HTMLInputElement).value = ''; }} />
        </label>
      ) : (
        <span class="muted">Choosing a whole folder isn't available on this device — choose files instead.</span>
      )}
    </div>
  );

  if (done) {
    return (
      <section>
        <h1>Upload files</h1>
        <div class="card success" role="status">
          <h2>✓ Uploaded {plural(done.count, 'file')} to '{done.name}'</h2>
          <div class="actions">
            <a class="button primary big" href="#/">Back to my files</a>
            <button type="button" class="big" onClick={() => setDone(null)}>Upload more</button>
          </div>
        </div>
      </section>
    );
  }

  if (busy) {
    return (
      <section>
        <h1>Upload files</h1>
        <div class="card" aria-live="polite">
          <h2>{phaseLabel}…</h2>
          <label>
            {prog.filesDone} of {plural(prog.filesTotal, 'file')} · {formatBytes(prog.bytesDone)} of {formatBytes(prog.bytesTotal)} ({pct}%)
            <progress max={100} value={pct} />
          </label>
          {Object.entries(prog.active).slice(0, 6).map(([p, f]) => (
            <label key={p} class="small">
              <span class="name">{p}</span>
              <progress max={100} value={Math.round(f * 100)} />
            </label>
          ))}
          <button type="button" onClick={() => abortRef.current?.abort()}>Cancel</button>
          <p class="muted">If anything goes wrong, nothing is saved — your cloud storage is only changed when the whole upload finishes.</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1>Upload files</h1>
      <p class="hint">Three quick steps: choose, name, upload.</p>

      <h2 class="step-title">1. Choose files</h2>
      {rows.length === 0 ? (
        <div
          class={`drop ${dragging ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>Click a button, or drag files or folders here.</p>
          {pickInputs}
        </div>
      ) : (
        <div class="card" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <p>
            ✓ <strong>{plural(included.length, 'file')}</strong> selected ({formatBytes(totalBytes)})
            {included.length < rows.length && <span class="muted"> — {rows.length - included.length} skipped</span>}
          </p>
          <div class="actions">
            <button type="button" onClick={clearAll}>Choose different files</button>
            <label class="button">
              Add more files
              <input type="file" multiple hidden onChange={(e) => { add(fromInput((e.target as HTMLInputElement).files)); (e.target as HTMLInputElement).value = ''; }} />
            </label>
          </div>
        </div>
      )}
      {tooBig.length > 0 && (
        <p role="alert" class="notice error">
          {plural(tooBig.length, 'file')} {tooBig.length === 1 ? 'is' : 'are'} too big to upload (the limit is {formatBytes(DEFAULT_LIMITS.fileMax)} each), for example {tooBig[0].path}. Open “Review files” below and untick {tooBig.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      <form onSubmit={(e) => { e.preventDefault(); if (canUpload) void start(); }}>
        <h2 class="step-title">2. Name it</h2>
        {rows.length === 0 ? (
          <p class="muted">Choose your files first.</p>
        ) : (
          <>
            <label>
              Name
              <input required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </label>
            <p class="hint">This is the name you'll see in My files. You can leave it as it is.</p>
            <details>
              <summary>Add a note or tags (optional)</summary>
              <label>Tags (separate with commas)<input value={tags} onInput={(e) => setTags((e.target as HTMLInputElement).value)} placeholder="work, taxes, 2025" /></label>
              <label>Note<textarea rows={3} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} /></label>
            </details>
          </>
        )}

        <h2 class="step-title">3. Upload</h2>
        <div class="actions">
          <button type="submit" class="primary big" disabled={!canUpload}>
            ⬆ Upload {included.length > 0 ? plural(included.length, 'file') : ''}
          </button>
        </div>
        {releaseCount > 0 && <p class="muted">{plural(releaseCount, 'large file')} will be stored separately; this can take longer.</p>}
      </form>
      {error && <p role="alert" class="notice error">{error}</p>}

      {rows.length > 0 && (
        <details class="review">
          <summary>Review files{included.length < rows.length ? ` (${included.length} of ${rows.length} selected)` : ''}</summary>
          <p class="hint">Untick anything you don't want to upload.</p>
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
                {patternExcluded(r.path) ? 'skipped' : classify(r.size) === 'release' ? `${formatBytes(r.size)} · large file` : formatBytes(r.size)}
              </span>
            )}
          />
          <details>
            <summary>Skip certain files (advanced)</summary>
            <textarea rows={4} aria-label="Files to skip" value={excludeText} onInput={(e) => setExcludeText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
            <p class="muted">One per line. <code>name/</code> = a folder, <code>*.log</code> = every file ending in .log. Files inside a <code>.git</code> folder are always skipped.</p>
          </details>
        </details>
      )}
    </section>
  );
}
