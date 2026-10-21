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
const PROFILE_WAIT = 240_000;   // per-profile window on CI's software renderer; see the note at the wait (198 s seen on a run whose longest frame was 14.6 s)
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
    // The loop below is bounded by its own per-visit waits (fly-to 60 s,
    // profile 120 s), so the test window is their sum plus boot: a slow
    // runner took 572 s for the loop alone (frames of up to 8.8 s under
    // software GL) and tripped a 600 s window after every profile rendered.
    test.setTimeout(ROUNDS * CITIES.length * (60_000 + PROFILE_WAIT + 5_000) + 120_000);
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
    const missed = [];
    const timings = [];
    const t0 = Date.now();
    for (let round = 0; round < ROUNDS; round++) {
      for (const id of cities) {
        const tCity = Date.now();
        await page.selectOption('#city-select', id);
        // Wait until the fly-to has actually landed (not settle(): with 3D
        // on the real map never reports idle; not a fixed wait: on a GPU-less
        // CI runner a 3D frame takes seconds, and a fixed wait read the old
        // city's centre and selected Indore twelve times).
        const city = await page.evaluate((id) => CitySelector.getCities().find((c) => c.id === id), id);
        expect(city, `city ${id} in CitySelector`).toBeTruthy();
        await page.waitForFunction(({ lat, lng }) => {
          const c = MapModule.getMap().getCenter();
          return Math.abs(c.lat - lat) < 0.02 && Math.abs(c.lng - lng) < 0.02;
        }, city, { timeout: 60_000 });
        await page.waitForTimeout(STUB ? 150 : 500);
        // Select the cell at the city centre to exercise the detail panel
        // each time. Fire-and-forget: the upstream feature fetch may hang in a
        // sandbox without network; the point is the churn, not the data.
        const code = await page.evaluate(({ lat, lng }) => {
          const code = DigiPin.format(DigiPin.encode(lat, lng));
          document.querySelectorAll('[data-cell-profile]').forEach((e) => e.remove());
          Promise.resolve().then(() => MapModule.selectByCode(code)).catch(() => {});
          return code;
        }, city);
        // The profile card for *this* code proves the panel opened and the
        // cell store was hit (the first CI run loaded no cell data at all).
        try {
          await page.waitForFunction((code) => {
            const t = document.getElementById('panel-title-text');
            return !!document.querySelector('[data-cell-profile=""]') && !!t && t.textContent.trim() === code;   // the real card, not the loading placeholder
          }, code, { timeout: PROFILE_WAIT });   // ~60 fetches per profile behind 2-4 s software-GL frames: 94 s then 135 s seen cold (Bengaluru, the latter with the 3D journey sharing the runner), a 60 s miss seen warm (Mumbai). The window is generous because the claim is "every profile renders", not "within N s"; per-city times are logged below.
          profiles++;
        } catch { missed.push(`${id}#${round + 1}`); }
        timings.push(`${id} ${((Date.now() - tCity) / 1000).toFixed(0)}s`);
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
    console.log(`soak: ${ROUNDS} rounds × ${cities.length} cities in ${((Date.now() - t0) / 1000).toFixed(0)} s (${timings.join(', ')})`);
    expect(profiles, `cell profiles rendered (one per city selection; missed: ${missed.join(', ') || 'none'})`).toBe(ROUNDS * cities.length);
    const freeze = await longTasks(page);
    // Without a GPU (CI's SwiftShader) every 3D frame is a 2-4 s task, which
    // says nothing about real machines: report, don't gate, in that case.
    const renderer = await page.evaluate(() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
      } catch { return 'unknown'; }
    });
    const softwareGl = /swiftshader|llvmpipe|software|mesa offscreen/i.test(renderer);
    console.log(`soak: renderer "${renderer}", longest freeze ${freeze.longest} ms, blocking ${freeze.blocking} ms${softwareGl ? ' (software GL: freeze budget not enforced)' : ''}`);
    if (!softwareGl) {
      expect(freeze.longest, `longest main-thread freeze ms (tasks: ${JSON.stringify(freeze.tasks.filter((t) => t.ms >= 300))})`).toBeLessThan(FREEZE_MS);
    }
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
