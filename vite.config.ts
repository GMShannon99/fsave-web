import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// The sign-in worker (optional) must be reachable from the page; allow only its origin.
const workerOrigin = (() => {
  try {
    return process.env.VITE_OAUTH_WORKER_URL ? new URL(process.env.VITE_OAUTH_WORKER_URL).origin : '';
  } catch {
    return '';
  }
})();

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  // api/uploads: GitHub REST. githubusercontent: GitHub's signed redirect targets for release-asset downloads.
  `connect-src https://api.github.com https://uploads.github.com https://*.githubusercontent.com${workerOrigin ? ` ${workerOrigin}` : ''}`,
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Injected only in production builds: Vite's dev server needs inline styles/HMR.
const cspPlugin = (): Plugin => ({
  name: 'fsave-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [preact(), cspPlugin()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/support/setup.ts'] },
} as Parameters<typeof defineConfig>[0]);
