// Offline robustness e2e — the regression guard for the precache fix.
//
// Before this milestone sw.js precached only ~19 of 52 modules; the rest were
// runtime-cached on first online use, so opening the app offline and using a
// feature you hadn't already touched (Compare, NDVI, Viewshed…) failed silently.
// This test warms the cache online, goes offline, reloads, and asserts those
// previously-unprecached module globals are present and the map still boots.
//
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');

test.describe('offline app shell', () => {
  test('boots offline with every module available', async ({ page, context }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('digipin_onboarded', 'done'); } catch { /* */ }
    });

    // 1) Warm online — the SW installs and precaches LOCAL_ASSETS + CDN libs.
    await page.goto('/app.html');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    // 2) Wait until the SW is active AND controlling this page (clients.claim()).
    await page.waitForFunction(async () => {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.ready;
      return !!navigator.serviceWorker.controller;
    }, null, { timeout: 30_000 });

    // 3) Cut the network and reload — everything must come from the SW cache.
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    // 4) Modules that were NOT in the old precache list must now be defined.
    //    (Referenced by name — they're top-level consts, not window props; the
    //    page CSP forbids eval, but page.evaluate runs a real function.)
    const types = await page.evaluate(() => ({
      Compare: typeof Compare,
      NDVIOverlay: typeof NDVIOverlay,
      Viewshed: typeof Viewshed,
      KDEOverlay: typeof KDEOverlay,
      AccessibilityOverlay: typeof AccessibilityOverlay,
      FloatingDialogs: typeof FloatingDialogs,
      ExportDialog: typeof ExportDialog,
      LayersPanel: typeof LayersPanel,
      Onboarding: typeof Onboarding,
      GrowthOverlay: typeof GrowthOverlay,
    }));
    const missing = Object.entries(types).filter(([, t]) => t === 'undefined').map(([k]) => k);
    expect(missing, `undefined offline (not precached): ${missing.join(', ')}`).toEqual([]);
  });
});
