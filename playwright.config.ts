import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4173', viewport: { width: 1000, height: 800 } },
  // Tests run against the production build (so the strict CSP is exercised too).
  webServer: [
    { command: 'npm run build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true, timeout: 120_000 },
    // Same app built with the "Sign in with GitHub" settings turned on (public values only).
    {
      command: 'npx vite build --outDir dist-oauth && npx vite preview --outDir dist-oauth --port 4174 --strictPort',
      url: 'http://localhost:4174',
      reuseExistingServer: true,
      timeout: 120_000,
      env: { VITE_GITHUB_CLIENT_ID: 'Iv1.test', VITE_GITHUB_APP_SLUG: 'fsave-test', VITE_OAUTH_WORKER_URL: 'https://fsave-oauth.test.workers.dev' },
    },
  ],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
