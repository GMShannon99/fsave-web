import { GitHubClient, GitHubError, type RepoInfo } from '../api/github';

export const DEFAULT_REPO_NAME = 'fsave-storage';

export type ConnectResult =
  | { status: 'connected'; info: RepoInfo }
  /** Signed in, but the app isn't installed on the storage repo yet (GitHub reports that as 404). */
  | { status: 'needs-install'; repo: string }
  | { status: 'public'; info: RepoInfo }
  | { status: 'no-write'; info: RepoInfo };

/**
 * After sign-in: find the storage repo (the configured one, else `<you>/fsave-storage`), verify it
 * is private and writable, and make sure it has a first commit so saving works.
 */
export async function connectStorage(o: {
  getToken: (force?: boolean) => Promise<string>;
  repo?: { owner: string; repo: string } | null;
  publicConfirmed?: string;
  fetchImpl?: typeof fetch;
}): Promise<ConnectResult> {
  const base = { getToken: o.getToken, fetchImpl: o.fetchImpl };
  let target = o.repo;
  if (!target) {
    const user = await new GitHubClient({ ...base, owner: '-', repo: '-' }).getUser();
    target = { owner: user.login, repo: DEFAULT_REPO_NAME };
  }
  const client = new GitHubClient({ ...base, owner: target.owner, repo: target.repo });
  let info: RepoInfo;
  try {
    info = await client.getRepo();
  } catch (e) {
    if (e instanceof GitHubError && e.kind === 'not-found') return { status: 'needs-install', repo: `${target.owner}/${target.repo}` };
    throw e;
  }
  if (!info.private && o.publicConfirmed !== info.full_name) return { status: 'public', info };
  if (info.permissions && info.permissions.push === false) return { status: 'no-write', info };
  await client.getHead(info.default_branch); // adds an initial README to a completely empty repo
  return { status: 'connected', info };
}
