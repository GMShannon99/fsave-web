import { http } from 'msw';
import { GitHubClient } from '../../src/api/github';
import { FakeGithub } from './fakeGithub';
import { server } from './setup';

/** Mounts a FakeGithub behind MSW and returns a client pointed at it. */
export function mountFake(fake = new FakeGithub()) {
  const handler = async ({ request }: { request: Request }) => {
    const buf = Buffer.from(await request.arrayBuffer());
    const r = fake.handle({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: buf.length ? buf : null,
    });
    return new Response(r.body === null ? null : typeof r.body === 'string' ? r.body : new Uint8Array(r.body), { status: r.status, headers: r.headers });
  };
  server.use(http.all('https://api.github.com/*', handler), http.all('https://uploads.github.com/*', handler));
  const sleeps: number[] = [];
  const client = new GitHubClient({
    token: fake.token,
    owner: fake.owner,
    repo: fake.repo,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { fake, client, sleeps };
}

export const file = (content: string | Uint8Array, name = 'f') => new File([content as BlobPart], name);
