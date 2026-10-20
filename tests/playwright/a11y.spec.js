// Accessibility gate — runs axe-core against the booted app chrome and checks
// keyboard affordances (skip link, toolbar reachability, focus management).
//
// axe-core is loaded from the CDN at test time (CI has network; the app already
// loads MapLibre from unpkg), so there's no new npm dependency / lockfile churn.
// The map canvas itself is excluded — it's a third-party WebGL surface we don't
// control — so the gate stays focused on OUR UI and only fails on serious /
// critical violations.
//
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');

const AXE_CDN = 'https://unpkg.com/axe-core@4.10.2/axe.min.js';

test.describe('accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('digipin_onboarded', 'done'); } catch { /* */ }
    });
    await page.goto('/app.html');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });
  });

  test('no serious or critical axe violations in the app chrome', async ({ page }) => {
    await page.addScriptTag({ url: AXE_CDN });
    await page.waitForFunction(() => typeof window.axe !== 'undefined', null, { timeout: 15_000 });

    const results = await page.evaluate(async () => {
      // Exclude the WebGL map surface + third-party MapLibre controls.
      return await window.axe.run(document, {
        exclude: [['#map'], ['.maplibregl-control-container']],
        resultTypes: ['violations'],
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
        // color-contrast is unreliable over translucent/backdrop-filter surfaces
        // (axe can't resolve the effective background) — keep the structural
        // rules (names, roles, labels, landmarks) which are deterministic.
        rules: { 'color-contrast': { enabled: false } },
      });
    });

    const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    const summary = serious.map(v => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help}`).join('\n');
    expect(serious, `serious/critical a11y violations:\n${summary}`).toEqual([]);
  });

  test('skip link is the first tab stop and targets the map', async ({ page }) => {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { cls: el && el.className, href: el && el.getAttribute && el.getAttribute('href') };
    });
    expect(focused.cls).toContain('skip-link');
    expect(focused.href).toBe('#map');
  });

  test('toolbar tool buttons are keyboard-reachable', async ({ page }) => {
    for (const id of ['btn-dt-layers', 'btn-compare', 'btn-bookmarks', 'btn-saved-views']) {
      const tabindex = await page.locator(`#${id}`).getAttribute('tabindex');
      // A real <button> is tabbable unless explicitly removed (tabindex="-1").
      expect(tabindex, `${id} should not be removed from the tab order`).not.toBe('-1');
    }
  });
});
