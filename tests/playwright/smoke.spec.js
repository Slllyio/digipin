// App-boot smoke test — the first runtime check of the real app.
//
// Verifies the page actually boots in a browser: MapLibre initialises, the
// toolbar (including the new overlay buttons) renders, the core module globals
// are defined, and toggling each new overlay on/off raises no UNCAUGHT
// exception. Network / console errors from blocked or slow upstreams are
// tolerated (they're handled gracefully in-app); a `pageerror` is a real bug.
//
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');

const NEW_OVERLAY_BUTTONS = ['btn-ndvi', 'btn-bivariate', 'btn-viewshed', 'btn-kde', 'btn-access'];

test.describe('App boot smoke', () => {
  let pageErrors;

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  });

  test('boots: map canvas, toolbar buttons, and core globals present', async ({ page }) => {
    await page.goto('/');
    // MapLibre creates its canvas once the library loads from the CDN.
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    for (const id of [...NEW_OVERLAY_BUTTONS, 'btn-heatmap', 'btn-3d', 'btn-compare']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }

    // The core modules are top-level `const` globals (lexical bindings), NOT
    // window properties, and the page CSP forbids eval — so reference each by
    // name statically. `typeof <undeclared>` is safe (yields 'undefined').
    const types = await page.evaluate(() => ({
      DigiPin: typeof DigiPin,
      DataFetcher: typeof DataFetcher,
      MapModule: typeof MapModule,
      App: typeof App,
      BivariateOverlay: typeof BivariateOverlay,
      NDVIOverlay: typeof NDVIOverlay,
      Viewshed: typeof Viewshed,
      KDEOverlay: typeof KDEOverlay,
    }));
    const missing = Object.entries(types).filter(([, t]) => t === 'undefined').map(([k]) => k);
    expect(missing, `undefined globals: ${missing.join(', ')}`).toEqual([]);

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  test('toggling each new overlay on/off raises no uncaught error', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    for (const id of NEW_OVERLAY_BUTTONS) {
      await page.click(`#${id}`);          // attach (starts sampling / DEM / raster)
      await page.waitForTimeout(800);
      await page.click(`#${id}`);          // detach (cleanup)
      await page.waitForTimeout(200);
    }

    expect(pageErrors, `uncaught errors during overlay toggle:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
