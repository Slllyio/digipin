// App-boot smoke test — the first runtime check of the real app.
//
// Verifies the page actually boots in a browser: MapLibre initialises, the
// collapsed toolbar renders (Layers/Compare/Saved/Views — the individual
// overlay buttons are hidden, folded into the unified Layers panel), the core
// module globals are defined, and toggling each analytics overlay through the
// Layers panel on/off raises no UNCAUGHT exception. Network / console errors
// from blocked or slow upstreams are tolerated (they're handled gracefully
// in-app); a `pageerror` is a real bug.
//
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');

// Overlays exercised through the Layers panel (rows drive the hidden buttons).
const PANEL_OVERLAYS = ['btn-ndvi', 'btn-bivariate', 'btn-viewshed', 'btn-kde', 'btn-access'];
const VISIBLE_TOOLBAR = ['btn-dt-layers', 'btn-compare', 'btn-bookmarks', 'btn-saved-views'];

test.describe('App boot smoke', () => {
  let pageErrors;

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
  });

  test('boots: map canvas, collapsed toolbar, and core globals present', async ({ page }) => {
    await page.goto('/');
    // MapLibre creates its canvas once the library loads from the CDN.
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    // The collapsed toolbar shows only the four tool entries…
    for (const id of VISIBLE_TOOLBAR) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    // …while the overlay buttons stay in the DOM (the panel drives them) but hidden.
    for (const id of [...PANEL_OVERLAYS, 'btn-heatmap', 'btn-3d']) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
      await expect(page.locator(`#${id}`)).toBeHidden();
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
      LayersPanel: typeof LayersPanel,
      ExportDialog: typeof ExportDialog,
    }));
    const missing = Object.entries(types).filter(([, t]) => t === 'undefined').map(([k]) => k);
    expect(missing, `undefined globals: ${missing.join(', ')}`).toEqual([]);

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  test('toggling each analytics overlay via the Layers panel raises no uncaught error', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    // Open the unified Layers panel (Analytics group is expanded by default).
    await page.click('#btn-dt-layers');
    await expect(page.locator('#dt-layers-dropdown')).toBeVisible();

    // Defensive: if anything closes the dropdown mid-loop, reopen it rather
    // than time out — this test's contract is "no uncaught errors".
    const ensureOpen = async () => {
      if (!(await page.locator('#dt-layers-dropdown').isVisible())) {
        await page.click('#btn-dt-layers');
      }
    };

    for (const id of PANEL_OVERLAYS) {
      const row = page.locator(`[data-layer-key="_btn_${id}"]`);
      await ensureOpen();
      await row.click();                   // attach (starts sampling / DEM / raster)
      await page.waitForTimeout(800);
      await ensureOpen();
      await row.click();                   // detach (cleanup)
      await page.waitForTimeout(200);
    }

    expect(pageErrors, `uncaught errors during overlay toggle:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
