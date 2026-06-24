// Playwright config for the DigiPin app-boot smoke test.
//
// Only the smoke spec runs in CI (testMatch below) — the older
// realtime-panels / growth-widget specs depend on live upstream data and
// are kept for local use. The webServer block boots the same Range-capable
// static server used for local dev. (CommonJS form — package.json is
// "type": "commonjs".)
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/playwright',
  // Deterministic specs only — smoke + the offline/workflow guards. The older
  // realtime-panels / growth-widget specs depend on live upstream data and are
  // kept for local use, so they're excluded.
  testMatch: /(smoke|workflows|offline|a11y)\.spec\.js/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'python serve.py 8000',
    url: 'http://localhost:8000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
