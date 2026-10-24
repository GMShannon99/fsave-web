import { describe, expect, it } from 'vitest';
import { GitHubError } from '../src/api/github';
import { buildZip, fetchVerified } from '../src/storage/download';
import { loadIndex, loadManifest, deleteSave, updateSave } from '../src/storage/repoOps';
import { TooLargeError, saveFiles, type ProgressEvent } from '../src/storage/saveService';
import { gitSha, FakeGithub } from './support/fakeGithub';
import { file, mountFake } from './support/harness';
import JSZip from 'jszip';

const input = (files: { path: string; content: string }[], extra = {}) => ({
  name: 'My save',
  tags: 'a, b',
  note: 'hello',
  device: 'test',
  files: files.map((f) => ({ path: f.path, file: file(f.content, f.path) })),
  ...extra,
});

describe('saveFiles / commit building', () => {
  it('creates ONE commit containing files, manifest and index', async () => {
    const { fake, client } = mountFake();
    const before = fake.commitCount();
    const events: ProgressEvent[] = [];
    const r = await saveFiles(client, 'main', input([{ path: 'proj/a b/ünï.txt', content: 'one' }, { path: 'proj/deep/x/y/z.txt', content: 'two' }]), { onProgress: (e) => events.push(e) });
    expect(fake.commitCount()).toBe(before + 1);
    expect(fake.text(`saves/${r.id}/files/proj/a b/ünï.txt`)).toBe('one');
    expect(fake.text(`saves/${r.id}/files/proj/deep/x/y/z.txt`)).toBe('two');
    const manifest = JSON.parse(fake.text(`saves/${r.id}/manifest.json`)!);
    expect(manifest).toMatchObject({ id: r.id, name: 'My save', tags: ['a', 'b'], note: 'hello', totalSize: 6 });
    expect(manifest.files[0]).toMatchObject({ storage: 'blob', gitSha: gitSha(Buffer.from(manifest.files[0].path.includes('a b') ? 'one' : 'two')) });
    expect(JSON.parse(fake.text('index.json')!).saves.map((s: { id: string }) => s.id)).toEqual([r.id]);
    expect(events.some((e) => e.type === 'phase' && e.phase === 'committing')).toBe(true);
    expect(events.filter((e) => e.type === 'overall').at(-1)).toMatchObject({ filesDone: 2, filesTotal: 2 });
  });

  it('skips uploading blobs that already exist (content dedup)', async () => {
    const { fake, client } = mountFake();
    await saveFiles(client, 'main', input([{ path: 'a.txt', content: 'same' }, { path: 'b.txt', content: 'same' }]));
    expect(fake.calls.filter((c) => c === 'POST api.github.com/repos/me/fsave-storage/git/blobs')).toHaveLength(1);
    fake.calls.length = 0;
    const r = await saveFiles(client, 'main', input([{ path: 'c.txt', content: 'same' }]));
    expect(fake.calls.some((c) => c.endsWith('/git/blobs'))).toBe(false);
    expect(r).toMatchObject({ uploadedBlobs: 0, reusedBlobs: 1 });
  });

  it('rebases onto the new head and retries once when the ref update conflicts', async () => {
    const { fake, client } = mountFake();
    await saveFiles(client, 'main', input([{ path: 'first.txt', content: '1' }]));
    fake.beforeUpdateRef = () => fake.externalCommit('other.txt', 'x');
    const r = await saveFiles(client, 'main', input([{ path: 'second.txt', content: '2' }]));
    expect(fake.text('other.txt')).toBe('x'); // the external commit survived
    expect(JSON.parse(fake.text('index.json')!).saves).toHaveLength(2);
    expect(fake.text(`saves/${r.id}/files/second.txt`)).toBe('2');
  });

  it('gives up with a clear error after a second conflict, committing nothing', async () => {
    const { fake, client } = mountFake();
    const head = () => fake.externalCommit('x', String(Math.random()));
    fake.beforeUpdateRef = () => {
      head();
      // re-arm for the retry
      const orig = fake.handle.bind(fake);
      let armed = true;
      fake.handle = (r) => {
        if (armed && r.method === 'PATCH') {
          armed = false;
          head();
        }
        return orig(r);
      };
    };
    await expect(saveFiles(client, 'main', input([{ path: 'a', content: '1' }]))).rejects.toMatchObject({ kind: 'conflict' });
    expect(fake.files().has('index.json')).toBe(false);
  });

  it('stores large files as release assets and records them in the manifest', async () => {
    const { fake, client } = mountFake();
    const limits = { blobMax: 5, fileMax: 1000 };
    const r = await saveFiles(client, 'main', input([{ path: 'small.txt', content: 'hi' }, { path: 'big/data.bin', content: 'this is large' }]), { limits });
    expect(r.releaseFiles).toBe(1);
    const m = JSON.parse(fake.text(`saves/${r.id}/manifest.json`)!);
    const big = m.files.find((f: { path: string }) => f.path === 'big/data.bin');
    expect(big).toMatchObject({ storage: 'release' });
    expect(fake.assets.get(big.assetId)!.data.toString()).toBe('this is large');
    expect(fake.files().has(`saves/${r.id}/files/big/data.bin`)).toBe(false);
    expect(m.releaseTag).toBe(`save-${r.id}`);
    // downloads verify
    expect((await fetchVerified(client, big)).verified).toBe(true);
  });

  it('rejects files over the hard limit with a clear message and touches nothing', async () => {
    const { fake, client } = mountFake();
    const err = await saveFiles(client, 'main', input([{ path: 'huge.bin', content: 'x'.repeat(20) }]), { limits: { blobMax: 5, fileMax: 10 } }).catch((e) => e);
    expect(err).toBeInstanceOf(TooLargeError);
    expect(err.message).toMatch(/huge\.bin/);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses paths inside .git', async () => {
    const { client } = mountFake();
    await expect(saveFiles(client, 'main', input([{ path: 'p/.git/config', content: 'x' }]))).rejects.toThrow(/\.git/);
  });

  it('cleans up the release and commits nothing when a blob upload fails mid-save', async () => {
    const { fake, client } = mountFake();
    fake.failBlobAfter = 0;
    const head = fake.head;
    await expect(
      saveFiles(client, 'main', input([{ path: 'big.bin', content: 'large content' }, { path: 'a.txt', content: 'a' }]), { limits: { blobMax: 5, fileMax: 1000 } }),
    ).rejects.toBeInstanceOf(GitHubError);
    expect(fake.head).toBe(head);
    expect(fake.releases.size).toBe(0);
    expect(fake.assets.size).toBe(0);
    expect(fake.tags.size).toBe(0);
  });

  it('cancellation aborts, cleans up and commits nothing', async () => {
    const { fake, client } = mountFake();
    const ctl = new AbortController();
    const head = fake.head;
    const p = saveFiles(client, 'main', input([{ path: 'big.bin', content: 'large content' }]), {
      limits: { blobMax: 5, fileMax: 1000 },
      signal: ctl.signal,
      onProgress: (e) => e.type === 'phase' && e.phase === 'uploading' && ctl.abort(),
    });
    await expect(p).rejects.toMatchObject({ kind: 'abort' });
    expect(fake.head).toBe(head);
    expect(fake.releases.size).toBe(0);
  });

  it('initialises an empty repository first', async () => {
    const { fake, client } = mountFake(new FakeGithub({ empty: true }));
    const r = await saveFiles(client, 'main', input([{ path: 'a.txt', content: 'a' }]));
    expect(fake.text(`saves/${r.id}/files/a.txt`)).toBe('a');
    expect(fake.text('README.md')).toBeDefined();
  });
});

describe('manage + download', () => {
  it('loads index/manifest, edits metadata, and deletes (incl. release) in single commits', async () => {
    const { fake, client } = mountFake();
    const r = await saveFiles(client, 'main', input([{ path: 'a.txt', content: 'a' }, { path: 'big.bin', content: 'large content' }]), { limits: { blobMax: 5, fileMax: 1000 } });
    expect((await loadIndex(client, 'main')).saves[0].id).toBe(r.id);

    let n = fake.commitCount();
    const m = await updateSave(client, 'main', r.id, { name: 'Renamed', tags: ['t'], note: 'new note' });
    expect(fake.commitCount()).toBe(n + 1);
    expect(m.name).toBe('Renamed');
    expect((await loadManifest(client, 'main', r.id)).note).toBe('new note');
    expect((await loadIndex(client, 'main')).saves[0]).toMatchObject({ name: 'Renamed', tags: ['t'] });

    n = fake.commitCount();
    const d = await deleteSave(client, 'main', r.id);
    expect(d.releaseError).toBeUndefined();
    expect(fake.commitCount()).toBe(n + 1);
    expect([...fake.files().keys()].filter((p) => p.startsWith('saves/'))).toEqual([]);
    expect(fake.releases.size).toBe(0);
    expect((await loadIndex(client, 'main')).saves).toEqual([]);
    await expect(loadManifest(client, 'main', r.id)).rejects.toMatchObject({ kind: 'not-found' });
    await expect(loadManifest(client, 'main', '../etc')).rejects.toThrow(/Invalid/);
  });

  it('builds a zip, verifying hashes and flagging mismatches', async () => {
    const { fake, client } = mountFake();
    const r = await saveFiles(client, 'main', input([{ path: 'dir/a.txt', content: 'alpha' }, { path: 'b.txt', content: 'beta' }]));
    const m = await loadManifest(client, 'main', r.id);
    let res = await buildZip(client, m, m.files);
    expect(res.failed).toEqual([]);
    const zip = await JSZip.loadAsync(await res.blob.arrayBuffer());
    expect(await zip.file('dir/a.txt')!.async('string')).toBe('alpha');
    // corrupt the manifest hash of one file
    m.files[0].sha256 = '0'.repeat(64);
    res = await buildZip(client, m, m.files);
    expect(res.failed).toEqual([m.files[0].path]);
    expect(fake.calls.length).toBeGreaterThan(0);
  });
});
