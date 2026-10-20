// Shared boot helpers for the Playwright journeys.
//
// `prepare(page)` seeds the onboarding flag, installs the pageerror collector,
// and (when STUB_MAP=1 — local sandboxes without CDN access) injects the
// MapLibre stand-in. `waitForApp(page)` resolves once the app's map object
// exists; with the real library it also waits for the canvas.
//
// CommonJS form — package.json is "type": "commonjs".
const path = require('node:path');

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
  });
  if (STUB) {
    await page.addInitScript({ path: path.join(__dirname, 'stub-map.js') });
    // Don't wait on CDNs that can't be reached.
    await page.route(/unpkg\.com|cdn\.jsdelivr\.net|fonts\.g(oogleapis|static)\.com|basemaps\.cartocdn\.com/, (r) => r.abort());
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

module.exports = { STUB, SAMPLE_CELL, SAMPLE_DATA, prepare, waitForApp, settle, openLayersPanel, toggleRow };
