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
    test.setTimeout(180_000);
    const own = track(page);
    await page.goto('/app.html');
    await waitForApp(page);
    await toggleRow(page, 'btn-buildings');
    await toggleRow(page, 'btn-3d');
    for (const id of ['delhi', 'mumbai', 'bengaluru', 'hyderabad', 'chennai', 'kolkata']) {
      await page.selectOption('#city-select', id);
      await settle(page, 1500);
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
