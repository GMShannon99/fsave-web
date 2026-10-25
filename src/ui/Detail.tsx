import { useEffect, useMemo, useState } from 'preact/hooks';
import { describeError } from '../api/github';
import { ZIP_WARN_BYTES, buildZip, fetchVerified, triggerDownload } from '../storage/download';
import { parseTags } from '../storage/manifest';
import { basename, buildTree, formatBytes, safeFileName } from '../storage/paths';
import { deleteSave, loadManifest, updateSave } from '../storage/repoOps';
import type { Manifest, ManifestFile } from '../storage/types';
import { useApp } from './app';
import { DOWNLOAD_STARTED, bigWarning } from './downloadSave';
import { FileTree } from './FileTree';
import { noteDeleted } from './recent';

export function Detail({ id }: { id: string }) {
  const { client, branch, settings } = useApp();
  const [m, setM] = useState<Manifest | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  // Nothing is ticked at first; "Download selected" only appears once something is.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [verify, setVerify] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', tags: '', note: '' });
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const ctl = new AbortController();
    loadManifest(client!, branch, id, ctl.signal).then(
      (mf) => {
        setM(mf);
        setForm({ name: mf.name, tags: mf.tags.join(', '), note: mf.note });
      },
      (e) => !ctl.signal.aborted && setError(describeError(e)),
    );
    return () => ctl.abort();
  }, [client, branch, id]);

  const tree = useMemo(() => buildTree(m?.files ?? []), [m]);
  if (error && !m) return <section><p role="alert" class="notice error">{error}</p><a href="#/">← Back to my files</a></section>;
  if (!m) return <section><p class="muted" role="status">Loading…</p></section>;

  const chosen = m.files.filter((f) => selected.has(f.path));
  const chosenBytes = chosen.reduce((s, f) => s + f.size, 0);
  const shareUrl = `${location.origin}${location.pathname}#/save/${m.id}?repo=${encodeURIComponent(settings.repo)}`;

  const run = async (label: string, fn: () => Promise<void>) => {
    setError('');
    setInfo('');
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy('');
    }
  };

  const downloadOne = (f: ManifestFile) =>
    run(`Downloading ${basename(f.path)}…`, async () => {
      const r = await fetchVerified(client!, f);
      setVerify((v) => ({ ...v, [f.path]: r.verified }));
      triggerDownload(new Blob([r.data]), basename(f.path));
      if (!r.verified) setError(`⚠ ${f.path} may be damaged. It was downloaded anyway, but it might not open properly.`);
      else setInfo(DOWNLOAD_STARTED);
    });

  const downloadZip = (files: ManifestFile[], suffix: string) => {
    const bytes = files.reduce((s, f) => s + f.size, 0);
    if (bytes > ZIP_WARN_BYTES && !confirm(bigWarning(bytes))) return;
    return run('Getting your files ready…', async () => {
      const { blob, failed } = await buildZip(client!, m, files, { onProgress: (d, t) => setBusy(`Getting your files ready… ${d} of ${t}`) });
      setVerify((v) => ({ ...v, ...Object.fromEntries(files.map((f) => [f.path, !failed.includes(f.path)])) }));
      triggerDownload(blob, `${safeFileName(m.name)}${suffix}.zip`);
      if (failed.length) setError(`⚠ ${failed.length} file(s) may be damaged: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}. Everything was downloaded anyway; a note inside the zip lists them.`);
      else setInfo(DOWNLOAD_STARTED);
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setInfo('Link copied. It works on your own computers once you are signed in.');
    } catch {
      prompt('Copy this link (it works on your own computers once you are signed in):', shareUrl);
    }
  };

  const saveEdit = () =>
    run('Saving…', async () => {
      const updated = await updateSave(client!, branch, m.id, { name: form.name, tags: parseTags(form.tags), note: form.note });
      setM(updated);
      setEditing(false);
      setInfo('✓ Changes saved.');
    });

  const doDelete = () =>
    run('Deleting…', async () => {
      const r = await deleteSave(client!, branch, m.id);
      noteDeleted(m.id);
      sessionStorage.setItem('fsave.flash', r.releaseError ? `Deleted “${m.name}”, but some large files could not be removed: ${r.releaseError}` : `✓ Deleted “${m.name}”.`);
      location.hash = '#/';
    });

  return (
    <section>
      <p><a href="#/">← My files</a></p>
      <h1>{m.name}</h1>
      <p class="muted">
        {new Date(m.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · {m.files.length} file{m.files.length === 1 ? '' : 's'} · {formatBytes(m.totalSize)} · from {m.source.device}
        {m.updatedAt ? ` · edited ${new Date(m.updatedAt).toLocaleDateString()}` : ''}
      </p>
      {m.tags.length > 0 && <p class="tags">{m.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</p>}
      {m.note && <p class="note">{m.note}</p>}

      <div class="actions">
        <button type="button" class="primary big" disabled={!!busy} onClick={() => downloadZip(m.files, '')}>⬇ Download all</button>
        {chosen.length > 0 && (
          <button type="button" class="big" disabled={!!busy} onClick={() => downloadZip(chosen, '-selection')}>
            Download selected ({chosen.length}, {formatBytes(chosenBytes)})
          </button>
        )}
      </div>

      {busy && <p role="status" class="notice">{busy}</p>}
      {info && <p role="status" class="notice ok">{info}</p>}
      {error && <p role="alert" class="notice error">{error}</p>}

      <h2>Files</h2>
      <p class="hint">Click <strong>Download</strong> next to a file, or tick the boxes to download only some of them.</p>
      <FileTree
        nodes={tree}
        selected={selected}
        onToggle={(paths, on) =>
          setSelected((s) => {
            const n = new Set(s);
            paths.forEach((p) => (on ? n.add(p) : n.delete(p)));
            return n;
          })
        }
        leaf={(f: ManifestFile & { path: string }) => (
          <>
            <span class="muted meta">{formatBytes(f.size)}{f.storage === 'release' ? ' · large file' : ''}</span>
            {verify[f.path] === true && <span class="ok" title="Checked: matches what was uploaded">✓</span>}
            {verify[f.path] === false && <span class="bad" role="img" aria-label="May be damaged" title="May be damaged">⚠</span>}
            <button type="button" class="link" disabled={!!busy} onClick={() => downloadOne(f)} aria-label={`Download ${f.path}`}>Download</button>
          </>
        )}
      />

      <details class="more">
        <summary>More options</summary>
        <div class="actions">
          <button type="button" onClick={() => setEditing(!editing)}>Rename or add a note</button>
          <button type="button" onClick={copyLink}>Copy link</button>
          <button type="button" class="danger-btn" onClick={() => setDeleting(!deleting)}>Delete this save…</button>
        </div>
        <p class="muted">The link is for your own computers. Other people can't open it unless you give them access to your storage on GitHub.</p>

        {editing && (
          <form class="card" onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
            <label>Name<input required value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} /></label>
            <label>Tags (separate with commas)<input value={form.tags} onInput={(e) => setForm({ ...form, tags: (e.target as HTMLInputElement).value })} /></label>
            <label>Note<textarea rows={3} value={form.note} onInput={(e) => setForm({ ...form, note: (e.target as HTMLTextAreaElement).value })} /></label>
            <div class="actions"><button class="primary" type="submit" disabled={!!busy}>Save changes</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div>
          </form>
        )}

        {deleting && (
          <div class="card danger">
            <h2>Delete this save?</h2>
            <p>This deletes the copy in your cloud storage. <strong>The original files on your computer are not affected.</strong></p>
            <details>
              <summary>For privacy experts</summary>
              <p class="muted">GitHub keeps older versions of your storage. After deleting, someone with access to your storage on GitHub could still recover the files from its history. The README explains how to remove them completely.</p>
            </details>
            <label>To confirm, type <code>{m.name}</code><input value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} /></label>
            <button type="button" class="danger-btn" disabled={typed !== m.name || !!busy} onClick={doDelete}>Delete permanently</button>
          </div>
        )}
      </details>
    </section>
  );
}
