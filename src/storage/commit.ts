import { GitHubError, type GitHubClient, type TreeInput } from '../api/github';

export interface HeadState {
  commitSha: string;
  treeSha: string;
}

/**
 * Builds ONE commit on `branch` via the Git Data API (tree -> commit -> ref update).
 * `prepare` is given the current head and returns the tree entries to apply; it is re-run against the
 * new head if the ref update loses a race (retried once), so index.json etc. are always rebased.
 * Entries with `sha: null` delete a path.
 */
export async function commitAtomic(
  client: GitHubClient,
  o: {
    branch: string;
    message: string;
    signal?: AbortSignal;
    prepare: (head: HeadState) => Promise<TreeInput[]>;
  },
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const head = await client.getHead(o.branch, o.signal);
    const entries = await o.prepare(head);
    const tree = await client.createTree(head.treeSha, entries, o.signal);
    const commit = await client.createCommit(o.message, tree, head.commitSha, o.signal);
    try {
      await client.updateRef(o.branch, commit, o.signal);
      return commit;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'conflict' && attempt === 0) continue;
      if (e instanceof GitHubError && e.kind === 'conflict') {
        throw new GitHubError('conflict', 'The storage repo changed twice while saving. Nothing was committed; please try again.');
      }
      throw e;
    }
  }
}

export const fileEntry = (path: string, sha: string): TreeInput => ({ path, mode: '100644', type: 'blob', sha });
export const textEntry = (path: string, content: string): TreeInput => ({ path, mode: '100644', type: 'blob', content });
export const deleteEntry = (path: string): TreeInput => ({ path, mode: '100644', type: 'blob', sha: null });
