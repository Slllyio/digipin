// Performance budgets measured in a real browser. Generous on purpose — they
// catch regressions of the "shipped a 20 MB file at boot" kind, not noise.
// Static-asset budgets (file sizes) live in tests/perf-budgets.test.js.
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { STUB, prepare, waitForApp, settle, toggleRow } = require('./helpers/app');

const BUDGET = {
  bootBytes: 4 * 1024 * 1024,    // own-origin bytes before first interaction
  bootRequests: 200,             // own-origin requests at boot
  interactiveMs: 15_000,         // toolbar usable (CI runners are slow)
  heapMb: 450,                   // JS heap after the 3D + city sweep (Chromium only)
  heightsBytes: 6 * 1024 * 1024, // any single building-heights file
  largestBytes: 6 * 1024 * 1024, // any single own-origin response during the journey
  // 3D draw cost per city view (DeckBuildings.renderStats()). Geometry counts
  // are machine-independent: a change that hands deck.gl ten times the
  // polygons shows here on any runner. The harvest + layer build is CPU-only
  // (no GL), so its time is gated too, loosely.
  polygons: 60_000,              // building polygons in one 3D view
  vertices: 1_000_000,           // their outer-ring vertices
  refreshMs: 5_000,              // longest single harvest + layer build
};

function track(page) {
  const own = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/localhost|127\.0\.0\.1/.test(u) || resp.request().method() !== 'GET') return;
    let size = 0;
    try { size = (await resp.body()).length; } catch { /* aborted / redirect */ }
    own.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), size, status: resp.status() });
  });
  return own;
}

test.describe('performance budgets', () => {
  let errors = [];
  test.beforeEach(async ({ page }) => { errors = await prepare(page); });
  test.afterEach(() => { expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]); });

  test('boot stays within the transfer and time budgets', async ({ page }) => {
    const own = track(page);
    const t0 = Date.now();
    await page.goto('/app.html');
    await waitForApp(page);
    await expect(page.locator('#btn-dt-layers')).toBeVisible();
    const interactive = Date.now() - t0;
    await settle(page, 1500);
    const bytes = own.reduce((a, r) => a + r.size, 0);
    const failed = own.filter((r) => r.status >= 400 && !/\.(geojson|tif|pmtiles)$/.test(r.url));
    console.log(`boot: ${own.length} requests, ${(bytes / 1048576).toFixed(2)} MB, interactive in ${interactive} ms`);
    expect(interactive, 'time to interactive').toBeLessThan(BUDGET.interactiveMs);
    expect(bytes, 'own-origin bytes at boot').toBeLessThan(BUDGET.bootBytes);
    expect(own.length, 'own-origin requests at boot').toBeLessThan(BUDGET.bootRequests);
    expect(failed.map((r) => r.url), 'unexpected 4xx/5xx at boot').toEqual([]);
  });

  test('Delhi-size 3D city and a city sweep stay within memory and file budgets', async ({ page }) => {
    test.setTimeout(400_000);   // the per-city draw wait below can take half a minute on CI's software renderer
    const own = track(page);
    await page.goto('/app.html');
    await waitForApp(page);
    await toggleRow(page, 'btn-buildings');
    await toggleRow(page, 'btn-3d');
    const draw = [];
    for (const id of ['delhi', 'mumbai', 'bengaluru', 'hyderabad', 'chennai', 'kolkata']) {
      await page.evaluate(() => { if (typeof DeckBuildings !== 'undefined') DeckBuildings.resetRenderStats(); });
      await page.selectOption('#city-select', id);
      await settle(page, 1500);
      // The harvest runs on moveend and again when footprint tiles land; on
      // the software renderer that can be tens of seconds after the fly-to.
      // Wait for one draw (not for idle: with 3D on the map never reports it).
      // A harvest between tiles can be empty (the first CI run logged 0
      // polygons for every city), so wait for a draw that has buildings.
      const tWait = Date.now();
      if (!STUB) {
        await page.waitForFunction(() => typeof DeckBuildings !== 'undefined' && DeckBuildings.renderStats().peakPolygons > 0, null, { timeout: 30_000 }).catch(() => {});
      }
      const r = await page.evaluate(() => {
        if (typeof DeckBuildings === 'undefined' || !DeckBuildings.renderStats) return null;
        const m = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        let loaded = null;
        try { loaded = m ? m.isSourceLoaded('overture-buildings-source') : null; } catch { loaded = null; }
        return { ...DeckBuildings.renderStats(), zoom: m && m.getZoom ? +m.getZoom().toFixed(2) : null, pitch: m && m.getPitch ? Math.round(m.getPitch()) : null, tilesLoaded: loaded };
      });
      if (r) draw.push({ id, waitedMs: Date.now() - tWait, ...r });
    }
    // One line per city so a regression in draw cost is visible in the CI log
    // before it is a failure: polygons / vertices handed to deck.gl, and the
    // longest harvest + layer build (ms) for that city.
    // First real baseline (CI, 2026-10-21): Delhi peak 8,529 polygons / 51,609
    // vertices (8,454 with baked heights), longest refresh 280 ms; the other
    // five cities had no footprint tiles rendered within 60 s of the fly-to
    // (Overture PMTiles range requests behind software-GL frames), so zoom,
    // pitch and the footprint source's loaded state are logged with each line.
    for (const d of draw) console.log(`3D draw ${d.id} [${d.mode}]: peak ${d.peakPolygons} polygons, ${d.peakVertices} vertices (${d.peakBySource.overture} overture / ${d.peakBySource.baked} baked / ${d.peakBySource.estimate} estimated heights), last draw ${d.polygons}, ${d.refreshes} refreshes, longest ${d.maxRefreshMs} ms; z${d.zoom} pitch ${d.pitch}, tiles loaded ${d.tilesLoaded}, waited ${Math.round(d.waitedMs / 1000)} s`);
    if (!STUB) {
      // Light theme draws through the MapLibre "twin" source, dark through the
      // deck.gl overlay; both report here. A city whose buildings did not land
      // in the wait is logged with peak 0 and not gated; all six empty means
      // the 3D city draws nothing, which is a failure.
      const live = draw.filter((d) => d.peakPolygons > 0);
      expect(live.length, `cities that drew 3D buildings (${draw.map((d) => `${d.id}:${d.peakPolygons}`).join(' ')})`).toBeGreaterThan(0);
      for (const d of live) {
        expect(d.peakPolygons, `${d.id}: polygons in one 3D view`).toBeLessThan(BUDGET.polygons);
        expect(d.peakVertices, `${d.id}: vertices in one 3D view`).toBeLessThan(BUDGET.vertices);
        expect(d.maxRefreshMs, `${d.id}: longest harvest + layer build ms`).toBeLessThan(BUDGET.refreshMs);
      }
    }
    const heights = own.filter((r) => /\/data\/heights\//.test(r.url));
    for (const h of heights) expect(h.size, `${h.url} is ${h.size} B`).toBeLessThan(BUDGET.heightsBytes);
    const biggest = own.reduce((m, r) => (r.size > m.size ? r : m), { size: 0, url: '' });
    console.log(`journey: ${own.length} requests, largest ${biggest.url} ${(biggest.size / 1048576).toFixed(2)} MB`);
    expect(biggest.size, `largest response ${biggest.url}`).toBeLessThan(BUDGET.largestBytes);
    // Heights must be fetched at most once per city (cache / dedupe).
    const perUrl = {};
    heights.forEach((h) => { perUrl[h.url] = (perUrl[h.url] || 0) + 1; });
    expect(Object.entries(perUrl).filter(([, n]) => n > 1).map(([u]) => u), 'heights fetched twice').toEqual([]);
    if (!STUB) {
      const heap = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0));
      console.log(`heap after journey: ${heap.toFixed(0)} MB`);
      expect(heap, 'JS heap MB').toBeLessThan(BUDGET.heapMb);
    }
  });
});
