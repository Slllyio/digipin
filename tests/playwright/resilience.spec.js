// Degraded-network behaviour — the app must stay usable, honest and quiet
// when data is missing, broken or slow. Offline-shell coverage lives in
// offline.spec.js. CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { STUB, prepare, waitForApp, openLayersPanel, settle } = require('./helpers/app');

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
    // The user is told, persistently, and can retry; the retry succeeds once
    // the store is reachable again.
    await expect(page.locator('#data-status .data-status-row[data-key="cellstore"]')).toBeVisible({ timeout: 15_000 });
    await page.unroute('**/data/cells/**');
    await page.click('#data-status .ds-action');
    await expect(page.locator('#data-status .data-status-row[data-key="cellstore"]')).toHaveCount(0, { timeout: 15_000 });
    expect(await page.evaluate(() => CellStore.isEnabled())).toBe(true);
    await openLayersPanel(page);
    await expect(page.locator('#dt-layers-dropdown')).toBeVisible();
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

  test('going offline shows a persistent notice that clears on reconnect', async ({ page, context }) => {
    await page.goto('/app.html');
    await waitForApp(page);
    await context.setOffline(true);
    await expect(page.locator('#data-status .data-status-row[data-key="offline"]')).toBeVisible({ timeout: 10_000 });
    await context.setOffline(false);
    await expect(page.locator('#data-status .data-status-row[data-key="offline"]')).toHaveCount(0, { timeout: 10_000 });
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

  test('an unreachable basemap CDN falls back to a plain style and the grid still draws', async ({ page }) => {
    test.skip(STUB, 'the stub map never fails to load its style');
    await page.route(/basemaps\.cartocdn\.com/, (r) => r.abort());
    await page.goto('/app.html');
    await waitForApp(page);
    await expect(page.locator('#data-status .data-status-row[data-key="basemap"]')).toBeVisible({ timeout: 20_000 });
    await settle(page, 1500);
    const state = await page.evaluate(() => ({
      ...MapModule.basemapState(),
      hasGrid: !!MapModule.getMap().getLayer('digipin-grid-fill'),
      styleName: MapModule.getMap().getStyle().name,
    }));
    expect(state.fellBack).toBe(true);
    expect(state.hasGrid).toBe(true);
    expect(state.styleName).toBe('digipin-fallback');
    // Deep-linking a cell still works on the fallback canvas.
    await page.evaluate(() => MapModule.selectByCode('34P-LL5-4L7'));
    await expect(page.locator('#detail-panel')).toHaveClass(/open/, { timeout: 20_000 });
  });

  test('an uncaught runtime error shows the crash notice with a Reload action', async ({ page }) => {
    await page.goto('/app.html');
    await waitForApp(page);
    // Throw outside any handler, as a broken third-party callback would.
    await page.evaluate(() => setTimeout(() => { throw new Error('synthetic crash for the guard'); }, 0));
    const row = page.locator('#data-status .data-status-row[data-key="crash"]');
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.locator('.ds-action')).toHaveText('Reload');
    expect(await page.evaluate(() => CrashGuard.recent().map((r) => r.message))).toContain('synthetic crash for the guard');
    // The synthetic error is the only one expected on this page.
    errors = errors.filter((e) => !/synthetic crash/.test(e));
  });
});
