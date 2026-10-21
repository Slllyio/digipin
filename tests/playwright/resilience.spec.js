// Degraded-network behaviour — the app must stay usable, honest and quiet
// when data is missing, broken or slow. Offline-shell coverage lives in
// offline.spec.js. CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { STUB, prepare, waitForApp, openLayersPanel, settle, toggleRow } = require('./helpers/app');

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

  test.describe('without the service worker', () => {
    // sw.js claims the page and answers every same-origin GET itself, and a
    // request the worker handles never reaches page.route(): the first CI runs
    // of this test saw no abort at all. Blocking the worker puts the route back
    // in the path. (The in-memory part cache is reset below for the same reason.)
    test.use({ serviceWorkers: 'block' });

  test('a layer whose parts fail mid-session names the layer and retries', async ({ page }) => {
    await page.goto('/app.html');
    await waitForApp(page);
    await settle(page, 500);
    // The link drops every part of the layer (how many parts a view needs
    // depends on the real map's bounds, so "half of them" is not a stable
    // recipe; the partial-gap bookkeeping is covered by tests/cell-store.test.js).
    // Boot already decoded some of this city's parts (profile, overview);
    // re-init empties the store's in-memory part cache so the layer must fetch.
    // The route goes in first: a boot-time loop (city overview, insights) is
    // still fetching parts at this point, and one that lands between the
    // cache reset and the route would be served from memory again (seen in
    // CI: show() returned true with nothing dropped).
    let dropped = 0;
    await page.route('**/data/cells/population/**', (r) => { dropped++; r.abort('failed'); });
    expect(await page.evaluate(() => CellStore.init())).toBe(true);
    const shown = await page.evaluate(() => CellLayers.show('population'));
    expect(shown).toBe(false);
    expect(dropped).toBeGreaterThan(0);
    const row = page.locator('#data-status .data-status-row[data-key="cellgaps:population"]');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/did not load/);
    const last = await page.evaluate(() => CellStore.lastLoad('population'));
    expect(last.unreachable).toBe(last.of);
    expect(await page.evaluate(() => CellStore.failedParts().length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => CrashGuard.count())).toBe(0);
    // Link back: Retry refetches only the failed parts and the notice clears.
    await page.unroute('**/data/cells/population/**');
    await row.locator('.ds-action').click();
    await expect(row).toHaveCount(0, { timeout: 60_000 });
    // Only the view's parts are refetched; a boot-time fetch the route also
    // dropped may still be listed, so the claim is about this load.
    expect((await page.evaluate(() => CellStore.lastLoad('population'))).unreachable).toBe(0);
    expect(await page.evaluate(() => CellLayers.isVisible('population'))).toBe(true);
  });

  test('3D heights that fail to load say so, draw estimates, and Retry recovers', async ({ page }) => {
    test.skip(STUB, 'deck.gl is not loaded under the stub map');
    test.setTimeout(300_000);   // 3D on CI's software GL: see journeys.spec.js
    await page.goto('/app.html');
    await waitForApp(page);
    // The baked height grids (one ~1-5 MB file per city) never arrive; the
    // index does, so the layer knows what it is missing.
    let dropped = 0;
    await page.route('**/data/heights/*_heights_digipin.json*', (r) => { dropped++; r.abort('failed'); });
    await toggleRow(page, 'btn-buildings');
    await toggleRow(page, 'btn-3d');
    const row = page.locator('#data-status .data-status-row[data-key="heights"]');
    await expect(row).toBeVisible({ timeout: 120_000 });
    await expect(row).toContainText(/estimated heights/);
    expect(dropped).toBeGreaterThan(0);
    expect(await page.evaluate(() => DeckBuildings.heightsCacheStats().failed)).toBeGreaterThan(0);
    // The city still draws: both layers stay on (which renderer draws them is
    // the theme's choice: deck.gl in dark, MapLibre extrusions in light).
    expect(await page.evaluate(() => ['btn-buildings', 'btn-3d'].map((id) => LayersPanel.isActive(id)))).toEqual([true, true]);
    expect(await page.evaluate(() => CrashGuard.count())).toBe(0);
    // Link back: Retry fetches the grid and the row goes.
    await page.unroute('**/data/heights/*_heights_digipin.json*');
    await row.locator('.ds-action').click();
    await expect(row).toHaveCount(0, { timeout: 120_000 });
    const stats = await page.evaluate(() => DeckBuildings.heightsCacheStats());
    expect(stats.failed).toBe(0);
    expect(stats.grids).toBeGreaterThan(0);
  });
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

  test('a slow link shows the loading splash with the page, not after the scripts', async ({ page, context }) => {
    // Fast-3G shaping via CDP (Chromium only): the deferred scripts take
    // ~13 s to arrive, during which the user used to see a still skeleton.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8, latency: 150 });
    const t0 = Date.now();
    await page.goto('/app.html', { waitUntil: 'commit' });
    const splash = page.locator('#app-splash');
    await expect(splash).toBeVisible({ timeout: 8000 });
    const shownAfter = Date.now() - t0;
    expect(shownAfter, `splash visible after ${shownAfter} ms`).toBeLessThan(8000);
    // The slow-link note replaces the sub-line while the scripts are still in flight.
    await expect(splash.locator('.splash-sub')).toContainText(/connection looks slow/, { timeout: 12_000 });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });
    await waitForApp(page);
    // Once the map is up the splash goes (the stub map reports loaded at once).
    await expect(splash).toBeHidden({ timeout: 20_000 });
    expect(await page.evaluate(() => CrashGuard.count())).toBe(0);
  });

  test('the point-cloud viewer failing to download says so and frees the panel', async ({ page }) => {
    // The viewer library is an ESM download from jsdelivr at first use. With
    // it refused, the sample button must end in an error toast, with the
    // panel's controls enabled again and no uncaught error.
    await page.route(/maplibre-gl-lidar/, (r) => r.abort('failed'));
    await page.goto('/app.html');
    await waitForApp(page);
    expect(await page.evaluate(() => PointCloud.open())).toBe(true);
    const panel = page.locator('#point-cloud-panel');
    await expect(panel).toBeVisible();
    await panel.locator('.point-cloud-sample').click();
    await expect(page.locator('#toast-container .toast-error .toast-title', { hasText: 'Point cloud' })).toBeVisible({ timeout: 20_000 });
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect(panel.locator('.point-cloud-sample')).toBeEnabled();
    expect(await page.evaluate(() => PointCloud.isBusy())).toBe(false);
    expect(await page.evaluate(() => CrashGuard.count())).toBe(0);
    await panel.locator('.point-cloud-close').click();
    await expect(panel).toHaveCount(0);
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

  test('hostile or malformed deep-link parameters boot cleanly and open nothing', async ({ page }) => {
    const q = [
      'cell=%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'q=%00%ff', 'score=../../etc', 'layers=,,,%3Cb%3E,' + 'x'.repeat(2000),
      'bc=__proto__', 'bh=constructor', 't=20xx-99', 'an=' + encodeURIComponent('[{"lat":"x","lng":null},1,"s"]'),
      'z=NaN', 'll=a,b', 'intel=%7B',
    ].join('&');
    await page.goto(`/app.html?${q}`);
    await waitForApp(page);
    await settle(page, 500);
    await expect(page.locator('#detail-panel')).not.toHaveClass(/open/);
    await expect(page.locator('#data-status .data-status-row[data-key="crash"]')).toHaveCount(0);
    expect(await page.evaluate(() => CrashGuard.count())).toBe(0);
    // Nothing from the query string was written into the DOM as markup.
    expect(await page.evaluate(() => document.body.innerHTML.includes('<script>alert(1)'))).toBe(false);
    await page.fill('#search-input', '34P-LL5-4L7');
    await page.press('#search-input', 'Enter');
    await expect(page.locator('#detail-panel')).toHaveClass(/open/, { timeout: 20_000 });
  });

  test('a missing map engine (CDN blocked) says so instead of a blank page', async ({ page }) => {
    test.skip(STUB, 'the stub defines maplibregl itself');
    await page.route(/unpkg\.com\/maplibre-gl/, (r) => r.abort());
    await page.goto('/app.html');
    const row = page.locator('#data-status .data-status-row[data-key="engine"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('.ds-action')).toHaveText('Retry');
    await expect(page.locator('#map .map-engine-missing')).toBeVisible();
    expect(await page.evaluate(() => CrashGuard.count())).toBe(0);
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
