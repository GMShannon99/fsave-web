import { GitHubClient, GitHubError } from '../api/github';
import { commitAtomic, deleteEntry, textEntry } from './commit';
import { isValidSaveId, parseIndex, removeSummary, summarize, toJson, upsertSummary } from './manifest';
import { repoFilePath } from './paths';
import { INDEX_PATH, manifestPath, releaseTag, type Manifest, type SaveIndex } from './types';

export async function loadIndex(client: GitHubClient, branch: string, signal?: AbortSignal): Promise<SaveIndex> {
  const head = await client.getHead(branch, signal);
  return parseIndex(await client.getTextAt(INDEX_PATH, head.commitSha, signal));
}

export async function loadManifest(client: GitHubClient, branch: string, id: string, signal?: AbortSignal): Promise<Manifest> {
  if (!isValidSaveId(id)) throw new Error('Invalid save id.');
  const head = await client.getHead(branch, signal);
  const text = await client.getTextAt(manifestPath(id), head.commitSha, signal);
  if (!text) throw new GitHubError('not-found', 'That save does not exist in the storage repo (it may have been deleted).');
  return JSON.parse(text) as Manifest;
}

export interface SaveEdits {
  name: string;
  tags: string[];
  note: string;
}

export async function updateSave(client: GitHubClient, branch: string, id: string, edits: SaveEdits): Promise<Manifest> {
  let updated!: Manifest;
  await commitAtomic(client, {
    branch,
    message: `Edit save "${edits.name}"`,
    prepare: async (h) => {
      const text = await client.getTextAt(manifestPath(id), h.commitSha);
      if (!text) throw new GitHubError('not-found', 'That save no longer exists.');
      updated = { ...(JSON.parse(text) as Manifest), ...edits, name: edits.name.trim() || id, updatedAt: new Date().toISOString() };
      const index = parseIndex(await client.getTextAt(INDEX_PATH, h.commitSha));
      return [textEntry(manifestPath(id), toJson(updated)), textEntry(INDEX_PATH, toJson(upsertSummary(index, summarize(updated))))];
    },
  });
  return updated;
}

/** Deletes the save's folder in one commit, then its release. Git history still contains the old files. */
export async function deleteSave(client: GitHubClient, branch: string, id: string): Promise<{ commitSha: string; releaseError?: string }> {
  if (!isValidSaveId(id)) throw new Error('Invalid save id.');
  let hadRelease = false;
  const commitSha = await commitAtomic(client, {
    branch,
    message: `Delete save ${id}`,
    prepare: async (h) => {
      const text = await client.getTextAt(manifestPath(id), h.commitSha);
      const index = removeSummary(parseIndex(await client.getTextAt(INDEX_PATH, h.commitSha)), id);
      const entries = [textEntry(INDEX_PATH, toJson(index))];
      if (text) {
        const m = JSON.parse(text) as Manifest;
        hadRelease = m.files.some((f) => f.storage === 'release');
        entries.push(deleteEntry(manifestPath(id)));
        for (const f of m.files) if (f.storage === 'blob') entries.push(deleteEntry(repoFilePath(id, f.path)));
      }
      return entries;
    },
  });
  if (!hadRelease) return { commitSha };
  try {
    await client.deleteReleaseByTag(releaseTag(id));
    return { commitSha };
  } catch (e) {
    return { commitSha, releaseError: e instanceof Error ? e.message : String(e) };
  }
}
