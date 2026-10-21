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
// CHROMIUM_PATH at a system Chromium if the bundled one is missing. For the
// real map in such a sandbox: LOCAL_LIBS=<dir> serves maplibre-gl.js/.css,
// deck.gl's dist.min.js and pmtiles.js from that folder (npm pack them) in
// place of the CDN, and PW_PROXY=http://host:port sends the browser through
// the sandbox's egress proxy so the tile buckets load. The webServer block
// boots the same Range-capable static server used for local dev. (CommonJS
// form — package.json is "type": "commonjs".)
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/playwright',
  // Deterministic specs only — smoke + the offline/workflow guards. The older
  // realtime-panels / growth-widget specs depend on live upstream data and are
  // kept for local use, so they're excluded.
  testMatch: /(smoke|workflows|offline|a11y|journeys|resilience|perf|soak|agents)\.spec\.js/,
  // CI runs the soak (two rounds over six cities, ~10 min on software GL)
  // in its own job so the other specs report in a third of the time;
  // PW_SKIP_SOAK=1 leaves it out of a run, PW_ONLY_SOAK=1 runs only it.
  testIgnore: process.env.PW_SKIP_SOAK ? /soak\.spec\.js/ : (process.env.PW_ONLY_SOAK ? /(smoke|workflows|offline|a11y|journeys|resilience|perf|agents)\.spec\.js/ : []),
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
        launchOptions: {
          ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
          // PW_PROXY=http://host:port sends the browser through an egress
          // proxy (sandboxes whose network is proxied); its TLS interception
          // is accepted so the tile buckets load.
          ...(process.env.PW_PROXY ? { proxy: { server: process.env.PW_PROXY, bypass: 'localhost,127.0.0.1' }, args: ['--ignore-certificate-errors'] } : {}),
        },
      },
    },
  ],
  webServer: {
    command: 'python serve.py 8000 --quiet',   // per-request lines would drown the CI log
    url: 'http://localhost:8000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
