// Cloudflare-mode e2e : built SPA (npm run build:cf -> dist) + real Pages Functions (functions/) + LOCAL D1 (wrangler pages dev, persisted in test-results/e2e-d1).
// Run: npm run build:cf ; npm run test:e2e:cf        (nothing remote is contacted ; AUTH_TOKEN_SECRET below is a throw-away dev value)
import { defineConfig, devices } from '@playwright/test';

// the original playwright.config.js (testDir ./e2e, recursive) also sees e2e/cf/*.spec.js : the specs skip themselves unless this is set
process.env.CF_E2E = '1';
const PORT = 8788;
const DB_ID = 'c64022bb-88eb-485f-94f7-dd9e9617e44c'; // wrangler.toml database_id ; resolved to the LOCAL sqlite by --persist-to
const SECRET = 'e2e-local-secret-0123456789abcdefghijklmnop';

export default defineConfig({
  testDir: './e2e/cf',
  testMatch: /.*\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  outputDir: 'test-results/e2e-cf-artifacts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'only-on-failure',
    actionTimeout: 10000
  },
  // CF_E2E_CHANNEL : use an installed browser (default msedge = preinstalled on Windows) when the bundled playwright chromium was not downloaded
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.CF_E2E_CHANNEL || 'msedge' } }],
  webServer: {
    // local เท่านั้น ห้ามเติมแฟล็ก remote (จะไปแตะ bucket จริง) ; --r2 FILES ต้องคงเป็น local
    command: `node e2e/cf/global-setup.mjs && npx wrangler pages dev dist --d1 DB=${DB_ID} --r2 FILES --persist-to test-results/e2e-d1 --port ${PORT} --ip 127.0.0.1 --binding AUTH_TOKEN_SECRET=${SECRET} --binding ENVIRONMENT=dev --binding FILE_STORAGE=r2 --compatibility-flag nodejs_compat --show-interactive-dev-session=false`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
