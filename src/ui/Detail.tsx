import { useEffect, useMemo, useState } from 'preact/hooks';
import { describeError } from '../api/github';
import { ZIP_WARN_BYTES, buildZip, fetchVerified, triggerDownload } from '../storage/download';
import { parseTags } from '../storage/manifest';
import { basename, buildTree, formatBytes, safeFileName } from '../storage/paths';
import { deleteSave, loadManifest, updateSave } from '../storage/repoOps';
import type { Manifest, ManifestFile } from '../storage/types';
import { useApp } from './app';
import { FileTree } from './FileTree';

export function Detail({ id }: { id: string }) {
  const { client, branch, settings } = useApp();
  const [m, setM] = useState<Manifest | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
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
        setSelected(new Set(mf.files.map((f) => f.path)));
        setForm({ name: mf.name, tags: mf.tags.join(', '), note: mf.note });
      },
      (e) => !ctl.signal.aborted && setError(describeError(e)),
    );
    return () => ctl.abort();
  }, [client, branch, id]);

  const tree = useMemo(() => buildTree(m?.files ?? []), [m]);
  if (error) return <section><p role="alert" class="notice error">{error}</p><a href="#/">← Back to saves</a></section>;
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
      if (!r.verified) setError(`⚠ ${f.path} does NOT match its recorded SHA-256. It was downloaded, but may be corrupted.`);
      else setInfo(`Downloaded ${f.path} (SHA-256 verified).`);
    });

  const downloadZip = (files: ManifestFile[], suffix: string) => {
    const bytes = files.reduce((s, f) => s + f.size, 0);
    if (bytes > ZIP_WARN_BYTES && !confirm(`This zip is ${formatBytes(bytes)}. It is built in memory in your browser and may fail or be slow. Continue?`)) return;
    return run('Building zip…', async () => {
      const { blob, failed } = await buildZip(client!, m, files, { onProgress: (d, t) => setBusy(`Fetching ${d}/${t} files…`) });
      setVerify((v) => ({ ...v, ...Object.fromEntries(files.map((f) => [f.path, !failed.includes(f.path)])) }));
      triggerDownload(blob, `${safeFileName(m.name)}${suffix}.zip`);
      if (failed.length) setError(`⚠ ${failed.length} file(s) failed SHA-256 verification (listed in FSAVE-VERIFICATION-FAILED.txt inside the zip): ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`);
      else setInfo(`Zip downloaded; all ${files.length} files verified against their SHA-256.`);
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setInfo('Link copied. Whoever opens it needs their own token with access to your storage repo.');
    } catch {
      prompt('Copy this link (viewers need their own token for the storage repo):', shareUrl);
    }
  };

  const saveEdit = () =>
    run('Saving…', async () => {
      const updated = await updateSave(client!, branch, m.id, { name: form.name, tags: parseTags(form.tags), note: form.note });
      setM(updated);
      setEditing(false);
      setInfo('Saved.');
    });

  const doDelete = () =>
    run('Deleting…', async () => {
      const r = await deleteSave(client!, branch, m.id);
      sessionStorage.setItem('fsave.flash', r.releaseError ? `Deleted, but the release could not be removed: ${r.releaseError}` : 'Deleted.');
      location.hash = '#/';
    });

  return (
    <section>
      <p><a href="#/">← All saves</a></p>
      <h1>{m.name}</h1>
      <p class="muted">
        {new Date(m.createdAt).toLocaleString()} · {m.files.length} files · {formatBytes(m.totalSize)} · from {m.source.device}
        {m.updatedAt ? ` · edited ${new Date(m.updatedAt).toLocaleDateString()}` : ''}
      </p>
      {m.tags.length > 0 && <p class="tags">{m.tags.map((t) => <span class="tag" key={t}>{t}</span>)}</p>}
      {m.note && <p class="note">{m.note}</p>}

      <div class="actions">
        <button type="button" class="primary" disabled={!!busy} onClick={() => downloadZip(m.files, '')}>Download all (zip)</button>
        <button type="button" disabled={!!busy || chosen.length === 0 || chosen.length === m.files.length} onClick={() => downloadZip(chosen, '-selection')}>
          Download selected ({chosen.length}, {formatBytes(chosenBytes)})
        </button>
        <button type="button" onClick={copyLink}>Copy share link</button>
        <button type="button" onClick={() => setEditing(!editing)}>Edit</button>
        <button type="button" class="danger-btn" onClick={() => setDeleting(!deleting)}>Delete…</button>
      </div>
      <p class="muted">Share links only work for people who have their own token with access to <code>{settings.repo}</code>.</p>

      {busy && <p role="status" class="notice">{busy}</p>}
      {info && <p role="status" class="notice ok">{info}</p>}
      {error && <p role="alert" class="notice error">{error}</p>}

      {editing && (
        <form class="card" onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
          <label>Name<input required value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} /></label>
          <label>Tags<input value={form.tags} onInput={(e) => setForm({ ...form, tags: (e.target as HTMLInputElement).value })} /></label>
          <label>Note<textarea rows={3} value={form.note} onInput={(e) => setForm({ ...form, note: (e.target as HTMLTextAreaElement).value })} /></label>
          <div class="actions"><button class="primary" type="submit" disabled={!!busy}>Save changes</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      )}

      {deleting && (
        <div class="card danger">
          <h2>Delete this save?</h2>
          <p>This removes the save's folder from the storage repo in one commit{m.releaseTag ? ' and deletes its release (large files)' : ''}. <strong>Git history still contains the deleted files</strong> — anyone with repo access can recover them from earlier commits. See the README for how to purge history.</p>
          <label>Type <code>{m.name}</code> to confirm<input value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} /></label>
          <button type="button" class="danger-btn" disabled={typed !== m.name || !!busy} onClick={doDelete}>Delete permanently</button>
        </div>
      )}

      <h2>Files</h2>
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
            <span class="muted meta">{formatBytes(f.size)}{f.storage === 'release' ? ' · release' : ''}</span>
            {verify[f.path] === true && <span class="ok" title="SHA-256 verified">✓</span>}
            {verify[f.path] === false && <span class="bad" role="img" aria-label="SHA-256 mismatch" title="SHA-256 mismatch">⚠</span>}
            <button type="button" class="link" disabled={!!busy} onClick={() => downloadOne(f)} aria-label={`Download ${f.path}`}>Download</button>
          </>
        )}
      />
    </section>
  );
}
