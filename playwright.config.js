// Playwright config for the DigiPin browser suite.
//
// CI runs the deterministic specs (testMatch below): boot smoke, workflows,
// offline shell, a11y, and the reliability suite — journeys (cities, 3D +
// terrain, cell deep link, exports, share links), resilience (503 / 404 /
// malformed / slow data) and performance budgets. The older realtime-panels /
// growth-widget specs depend on live upstream data and are kept for local use.
//
// Local sandboxes without CDN access: `STUB_MAP=1 npx playwright test` swaps
// in tests/playwright/helpers/stub-map.js (no WebGL, no tiles); point
// CHROMIUM_PATH at a system Chromium if the bundled one is missing. The
// webServer block boots the same Range-capable static server used for local
// dev. (CommonJS form — package.json is "type": "commonjs".)
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/playwright',
  // Deterministic specs only — smoke + the offline/workflow guards. The older
  // realtime-panels / growth-widget specs depend on live upstream data and are
  // kept for local use, so they're excluded.
  testMatch: /(smoke|workflows|offline|a11y|journeys|resilience|perf|soak)\.spec\.js/,
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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Local sandboxes may only have a system Chromium; CI installs its own.
        ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
      },
    },
  ],
  webServer: {
    command: 'python serve.py 8000',
    url: 'http://localhost:8000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
