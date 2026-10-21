// Shared boot helpers for the Playwright journeys.
//
// `prepare(page)` seeds the onboarding flag, installs the pageerror collector,
// and (when STUB_MAP=1 — local sandboxes without CDN access) injects the
// MapLibre stand-in. `waitForApp(page)` resolves once the app's map object
// exists; with the real library it also waits for the canvas.
//
// CommonJS form — package.json is "type": "commonjs".
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_LIBS = process.env.LOCAL_LIBS || '';
const STUB = process.env.STUB_MAP === '1';
// Minimal cell + data objects for exercising the Export dialog without a
// live upstream fetch (which Overpass / GEE may refuse in CI).
const SAMPLE_CELL = {
  code: '34P-LL5-4L7',
  center: { lat: 22.7196, lng: 75.8577 },
  bounds: { minLat: 22.7186, maxLat: 22.7206, minLng: 75.8567, maxLng: 75.8587 },
};
const SAMPLE_DATA = {
  features: {},
  scores: { walkability: { value: 61, label: 'Walkability' }, safety: { value: 48, label: 'Safety' } },
  sources: [],
};

async function prepare(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String((err && err.message) || err)));
  await page.addInitScript(() => {
    try { localStorage.setItem('digipin_onboarded', 'done'); } catch { /* storage blocked */ }
    // Main-thread freezes: every long task (> 50 ms) since page start, for
    // the freeze budget in soak.spec.js. Read with longTasks(page).
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push({ t: Math.round(e.startTime), ms: Math.round(e.duration) });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* no Long Tasks API */ }
  });
  if (STUB) {
    await page.addInitScript({ path: path.join(__dirname, 'stub-map.js') });
    // Don't wait on CDNs that can't be reached.
    await page.route(/unpkg\.com|cdn\.jsdelivr\.net|fonts\.g(oogleapis|static)\.com|basemaps\.cartocdn\.com/, (r) => r.abort());
  } else if (LOCAL_LIBS) {
    // Real map libraries from a local folder (npm pack maplibre-gl deck.gl
    // pmtiles, then copy maplibre-gl.js/.css, dist.min.js and pmtiles.js into
    // it) for a sandbox that can reach the tile buckets but not the CDNs. A
    // CDN file that isn't in the folder is aborted rather than fetched.
    await page.route(/unpkg\.com|cdn\.jsdelivr\.net/, (r) => {
      const file = path.join(LOCAL_LIBS, path.basename(new URL(r.request().url()).pathname));
      return fs.existsSync(file) ? r.fulfill({ path: file }) : r.abort();
    });
  }
  return errors;
}

async function waitForApp(page, timeout = 30_000) {
  await page.waitForFunction(
    () => typeof MapModule !== 'undefined' && MapModule.getMap && !!MapModule.getMap(),
    null, { timeout },
  );
  if (!STUB) await page.waitForSelector('.maplibregl-canvas', { timeout });
}

/** Resolve after the map goes idle (real lib) or after a short settle (stub). */
async function settle(page, ms = 800) {
  if (STUB) { await page.waitForTimeout(ms); return; }
  await page.evaluate((ms) => new Promise((res) => {
    const map = MapModule.getMap();
    const t = setTimeout(res, ms + 6000);
    map.once('idle', () => { clearTimeout(t); setTimeout(res, ms); });
  }), ms).catch(() => {});
}

async function openLayersPanel(page) {
  const dd = page.locator('#dt-layers-dropdown');
  if (!(await dd.isVisible())) await page.click('#btn-dt-layers');
  await dd.waitFor({ state: 'visible' });
}

/** Toggle a Layers-panel analytics row (e.g. 'btn-3d') via its row, as a user would. */
async function toggleRow(page, btnId) {
  await openLayersPanel(page);
  await page.locator(`[data-layer-key="_btn_${btnId}"]`).click();
}

/** Long tasks recorded so far (ms each) and the longest; cleared when `reset` is true. */
async function longTasks(page, reset = false) {
  return page.evaluate((reset) => {
    const tasks = (window.__longTasks || []).slice();
    if (reset) window.__longTasks = [];
    const longest = tasks.reduce((m, t) => Math.max(m, t.ms), 0);
    const blocking = tasks.reduce((a, t) => a + Math.max(0, t.ms - 50), 0);
    return { count: tasks.length, longest, blocking, tasks };
  }, reset);
}

module.exports = { STUB, SAMPLE_CELL, SAMPLE_DATA, prepare, waitForApp, settle, openLayersPanel, toggleRow, longTasks };
