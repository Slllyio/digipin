// Soak: repeat the heaviest user loop (city switch with 3D buildings on,
// layer toggles, cell selection) and check the app neither leaks nor logs
// errors. Heap growth is only measured in the real browser (Chromium exposes
// performance.memory); the stub run still checks console/uncaught errors.
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { STUB, prepare, waitForApp, settle, toggleRow, longTasks } = require('./helpers/app');

// The six heaviest cities: a cell click there pulls ~60 dataset views through
// the profile + insights engines, which is the churn this soak is after.
const CITIES = ['indore', 'delhi', 'mumbai', 'bengaluru', 'hyderabad', 'chennai'];
const ROUNDS = 2;
const GROWTH_MB = 120;   // allowed heap growth between round 1 and round 2 (caches warm by then)
const HEAP_MB = 450;     // absolute ceiling after the soak (matches perf.spec.js)
// Main-thread freeze budget after boot: one city switch + cell click may not
// lock the page for longer than this in one go (the rank freeze was 3-5 s).
const FREEZE_MS = 1500;
const NOISE = /Failed to load resource|net::ERR_|the server responded with a status of|WebGL|deprecated/i;

async function heapMb(page) {
  return page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0));
}

test.describe('soak', () => {
  // A retry would double a 5-10 min job; a real regression shows up on the next push anyway.
  test.describe.configure({ retries: 0 });
  let errors = [];
  const consoleErrors = [];
  test.beforeEach(async ({ page }) => {
    errors = await prepare(page);
    page.on('console', (msg) => { if (msg.type() === 'error' && !NOISE.test(msg.text())) consoleErrors.push(msg.text()); });
  });
  test.afterEach(() => {
    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('two rounds over the big cities with 3D on and a cell selected stay error-free and do not leak', async ({ page }) => {
    test.setTimeout(600_000);   // ~20 s per city in the real browser × 12, with headroom
    await page.goto('/app.html');
    await waitForApp(page);
    const available = await page.$$eval('#city-select option', (os) => os.map((o) => o.value));
    const cities = CITIES.filter((c) => available.includes(c));
    expect(cities.length, 'cities in the picker').toBeGreaterThan(3);
    await toggleRow(page, 'btn-buildings');
    await toggleRow(page, 'btn-3d');
    await settle(page, 500);
    await longTasks(page, true);   // boot and layer setup are measured by perf.spec.js, not here
    const heaps = [];
    let profiles = 0;
    const t0 = Date.now();
    for (let round = 0; round < ROUNDS; round++) {
      for (const id of cities) {
        await page.selectOption('#city-select', id);
        // Not settle(): with 3D buildings on the real map never reports
        // idle, so each settle() burnt its whole 6 s fallback (12 of them
        // put the first CI run past the test timeout).
        await page.waitForTimeout(STUB ? 150 : 1200);
        // Select a cell at the city centre to exercise the detail panel each
        // time. Fire-and-forget: the upstream feature fetch may hang in a
        // sandbox without network, and the point is the churn, not the data.
        await page.evaluate(() => {
          const c = MapModule.getMap().getCenter();
          const code = DigiPin.encode(c.lat, c.lng);
          document.querySelectorAll('[data-cell-profile]').forEach((e) => e.remove());
          Promise.resolve().then(() => MapModule.selectByCode(code)).catch(() => {});
        });
        // The profile card proves the panel opened and the cell store was hit;
        // the first CI run showed zero cell-store parts loaded because the
        // selection waited on a map 'idle' that never came with 3D on.
        try {
          await page.waitForFunction(() => !!document.querySelector('[data-cell-profile]'), null, { timeout: 20_000 });
          profiles++;
        } catch { /* counted below */ }
        await page.waitForTimeout(STUB ? 400 : 800);
      }
      // Force a full GC through CDP so the heap number is retained memory, not garbage.
      try { const cdp = await page.context().newCDPSession(page); await cdp.send('HeapProfiler.collectGarbage'); await cdp.detach(); } catch { /* not Chromium */ }
      await page.waitForTimeout(1000);
      heaps.push(await heapMb(page));
      const cache = await page.evaluate(() => ({
        cells: (typeof CellStore !== 'undefined' && CellStore.cacheStats) ? CellStore.cacheStats() : null,
        heights: (typeof DeckBuildings !== 'undefined' && DeckBuildings.heightsCacheStats) ? DeckBuildings.heightsCacheStats() : null,
      }));
      const lt = await longTasks(page);
      console.log(`soak round ${round + 1}: heap ${heaps.at(-1).toFixed(0)} MB, long tasks ${lt.count} (longest ${lt.longest} ms, blocking ${lt.blocking} ms), caches ${JSON.stringify(cache)}`);
    }
    console.log(`soak: ${ROUNDS} rounds × ${cities.length} cities in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    expect(profiles, 'cell profiles rendered (one per city selection)').toBe(ROUNDS * cities.length);
    const freeze = await longTasks(page);
    expect(freeze.longest, `longest main-thread freeze ms (tasks: ${JSON.stringify(freeze.tasks.filter((t) => t.ms >= 300))})`).toBeLessThan(FREEZE_MS);
    expect(await page.evaluate(() => CrashGuard.count()), 'CrashGuard count').toBe(0);
    expect(await page.evaluate(() => DataStatus.active()), 'degraded-state notices').toEqual([]);
    const cache = await page.evaluate(() => (typeof CellStore !== 'undefined' && CellStore.cacheStats) ? CellStore.cacheStats() : null);
    if (cache) {
      expect(cache.parts, 'cell-store parts were actually loaded by the selections').toBeGreaterThan(0);
      expect(cache.bytes, 'decoded cell-store parts stay within budget').toBeLessThanOrEqual(cache.budget);
    }
    if (heaps.length === ROUNDS && heaps[0] > 0) {
      expect(heaps[1] - heaps[0], `heap growth MB round1→round2 (${heaps.map((h) => h.toFixed(0)).join(' → ')})`).toBeLessThan(GROWTH_MB);
      expect(heaps[1], 'heap after the soak').toBeLessThan(HEAP_MB);
    }
  });
});
