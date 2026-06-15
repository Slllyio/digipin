// Core workflow e2e — exercises real wiring the single smoke test doesn't:
// first-run onboarding, DigiPin-code search, theme persistence, and the
// Layers-panel + Escape-to-close path. Deliberately limited to interactions
// that need NO live upstream data, so it's deterministic in CI (the cell-click
// → detail-panel path depends on Overpass/Open-Meteo and is left to manual /
// mocked testing).
//
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');

const suppressOnboarding = (page) =>
  page.addInitScript(() => {
    try { localStorage.setItem('digipin_onboarded', 'done'); } catch { /* storage blocked */ }
  });

test.describe('first-run onboarding', () => {
  test('shows once and stays dismissed', async ({ page }) => {
    await page.goto('/app.html');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    const modal = page.locator('#onboarding-backdrop');
    await expect(modal).toBeVisible();

    // Dismiss via "Start exploring" (advance step 1 → 2 → close).
    await page.locator('.onboarding-next').click();   // → step 2
    await page.locator('.onboarding-next').click();   // → dismiss
    await expect(modal).toHaveCount(0);

    // The flag persists, so a reload does NOT re-show it.
    await page.reload();
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });
    await expect(page.locator('#onboarding-backdrop')).toHaveCount(0);
  });
});

test.describe('core interactions', () => {
  test.beforeEach(async ({ page }) => {
    await suppressOnboarding(page);
  });

  test('searching a DigiPin code flies the map and confirms', async ({ page }) => {
    await page.goto('/app.html');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    // A full 10-char Indore code — decoded entirely client-side (no network).
    await page.fill('#search-input', '4PJ9-K3LM-T8');
    await page.click('#search-btn');

    // The specific success toast (not the persistent welcome toast, which also
    // contains "DigiPin") proves decode → flyTo ran end-to-end.
    await expect(
      page.locator('#toast-container .toast-title', { hasText: 'DigiPin Found' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('theme toggle persists across reload', async ({ page }) => {
    await page.goto('/app.html');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    // Default is dark (no data-theme attribute).
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');
    await page.click('#theme-toggle-btn');               // toggle() reloads the page
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const stored = await page.evaluate(() => localStorage.getItem('digipin_theme'));
    expect(stored).toBe('light');
  });

  test('Escape closes the open Layers dropdown', async ({ page }) => {
    await page.goto('/app.html');
    await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });

    await page.click('#btn-dt-layers');
    await expect(page.locator('#dt-layers-dropdown')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#dt-layers-dropdown')).not.toHaveClass(/open/);
  });
});
