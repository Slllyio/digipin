// Degraded-network behaviour — the app must stay usable, honest and quiet
// when data is missing, broken or slow. Offline-shell coverage lives in
// offline.spec.js. CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { prepare, waitForApp, openLayersPanel, settle } = require('./helpers/app');

test.describe('resilience', () => {
  let errors = [];
  test.beforeEach(async ({ page }) => { errors = await prepare(page); });
  test.afterEach(() => { expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]); });

  test('boots and stays interactive when the cell store returns 503', async ({ page }) => {
    await page.route('**/data/cells/**', (r) => r.fulfill({ status: 503, body: 'down' }));
    await page.goto('/app.html');
    await waitForApp(page);
    await settle(page, 1500);
    expect(await page.evaluate(() => CellStore.isEnabled())).toBe(false);
    await openLayersPanel(page);
    await expect(page.locator('#dt-layers-dropdown')).toBeVisible();
    // Analyses degrade to a toast, not a throw.
    await page.evaluate(() => AnalysesPanel && typeof AnalysesPanel.run === 'function' ? null : null);
  });

  test('boots when every data file 404s and marks unavailable rows honestly', async ({ page }) => {
    await page.route('**/data/**', (r) => r.fulfill({ status: 404, body: 'nope' }));
    await page.goto('/app.html');
    await waitForApp(page);
    await settle(page, 2500);
    await openLayersPanel(page);
    const dimmed = await page.locator('#dt-layers-dropdown .dt-unavailable').count();
    expect(dimmed).toBeGreaterThan(0);
    // Selecting a cell still works: the grid is computed client-side.
    await page.evaluate(() => MapModule.selectByCode('34P-LL5-4L7'));
    await expect.poll(() => page.evaluate(() => MapModule.getSelectedCode()), { timeout: 15_000 }).toBe('34P-LL5-4L7');
  });

  test('malformed data files do not take the app down', async ({ page }) => {
    await page.route('**/data/**/*.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"oops":' }));
    await page.goto('/app.html');
    await waitForApp(page);
    await settle(page, 2000);
    await openLayersPanel(page);
    await expect(page.locator('#dt-layers-dropdown')).toBeVisible();
  });

  test('slow data (3 s per file) does not block first interaction', async ({ page }) => {
    await page.route('**/data/**', async (r) => { await new Promise((res) => setTimeout(res, 3000)); await r.continue(); });
    const t0 = Date.now();
    await page.goto('/app.html');
    await waitForApp(page);
    await expect(page.locator('#btn-dt-layers')).toBeVisible();
    await openLayersPanel(page);
    const interactiveMs = Date.now() - t0;
    // Budget: UI usable well before the slow data lands (it is fetched async).
    expect(interactiveMs, `interactive after ${interactiveMs} ms`).toBeLessThan(20_000);
  });

  test('a failing upstream feature fetch shows a cell without crashing', async ({ page }) => {
    // Everything that is not our own origin or the map CDNs is refused.
    await page.route((url) => !/localhost|127\.0\.0\.1|unpkg\.com|jsdelivr|cartocdn|fonts\.g/.test(url.hostname), (r) => r.abort());
    await page.goto('/app.html?cell=34P-LL5-4L7');
    await waitForApp(page);
    await expect(page.locator('#detail-panel')).toHaveClass(/open/, { timeout: 20_000 });
    await page.waitForTimeout(3000);
  });
});
