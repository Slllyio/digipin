// User journeys through the integrated build — the reliability smoke suite.
//
// Each test is a thing a stakeholder actually does: pick every city, turn on
// the 3D city with terrain, open a cell from a link, export it, share the
// view. The contract is: it works, and nothing throws. Upstream data feeds
// may be slow or refused in CI, so the tests assert on app state (selected
// cell, active layers, download events), never on remote content.
//
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { STUB, SAMPLE_CELL, SAMPLE_DATA, prepare, waitForApp, settle, toggleRow } = require('./helpers/app');

const CELL = '34P-LL5-4L7';

test.describe('journeys', () => {
  let errors = [];
  test.beforeEach(async ({ page }) => { errors = await prepare(page); });
  test.afterEach(() => { expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]); });

  test('every city loads from the city picker', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/app.html');
    await waitForApp(page);
    const ids = await page.evaluate(() => CitySelector.getCities().map((c) => c.id));
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const id of ids) {
      await page.selectOption('#city-select', id);
      await settle(page, 400);
      const cur = await page.evaluate(() => CitySelector.getCurrent().id);
      expect(cur).toBe(id);
    }
    // The map really moved: last city's centre is where the camera is.
    const ok = await page.evaluate(() => {
      const c = CitySelector.getCurrent(); const m = MapModule.getMap().getCenter();
      return Math.abs(m.lat - c.lat) < 0.5 && Math.abs(m.lng - c.lng) < 0.5;
    });
    expect(ok).toBe(true);
  });

  test('3D city: buildings + terrain + 3D toggle on and off together', async ({ page }) => {
    // 67 s alone on CI's software GL; with the Delhi perf journey or the soak
    // on the other worker every 3D frame is a 3-7 s task and each evaluate
    // waits behind one (two 120 s timeouts seen). The claim is "it works",
    // not "within N s", so the window is wide.
    test.setTimeout(300_000);
    await page.goto('/app.html');
    await waitForApp(page);
    for (const id of ['btn-buildings', 'btn-terrain', 'btn-3d']) await toggleRow(page, id);
    await settle(page, 1500);
    const active = await page.evaluate(() => ['btn-buildings', 'btn-terrain', 'btn-3d'].map((id) => LayersPanel.isActive(id)));
    expect(active).toEqual([true, true, true]);
    if (!STUB) {
      // Terrain is really attached to the style and the camera is pitched.
      const state = await page.evaluate(() => {
        const m = MapModule.getMap();
        return { terrain: !!m.getTerrain(), pitch: m.getPitch() };
      });
      expect(state.terrain).toBe(true);
      expect(state.pitch).toBeGreaterThan(0);
    }
    // Share-link state carries them.
    expect(await page.evaluate(() => URLState.activeLayers())).toEqual(expect.arrayContaining(['buildings', 'terrain', '3d']));
    // Leaving 3D mode also drops the terrain it switched on (documented
    // coupling in app.js); buildings stay until turned off themselves.
    await toggleRow(page, 'btn-3d');
    await settle(page, 800);
    expect(await page.evaluate(() => URLState.activeLayers())).toEqual(['buildings']);
    await toggleRow(page, 'btn-buildings');
    await settle(page, 400);
    expect(await page.evaluate(() => URLState.activeLayers())).toEqual([]);
  });

  test('cell deep link selects the cell and opens its profile', async ({ page }) => {
    await page.goto(`/app.html?cell=${CELL}`);
    await waitForApp(page);
    await expect.poll(() => page.evaluate(() => MapModule.getSelectedCode()), { timeout: 20_000 }).toBe(CELL);
    await expect(page.locator('#detail-panel')).toHaveClass(/open/, { timeout: 20_000 });
    await expect(page.locator('#panel-title-text')).toHaveText(CELL);
    await expect.poll(() => page.locator('#panel-content').evaluate((el) => el.textContent.trim().length)).toBeGreaterThan(50);
  });

  test('export dialog: every format tab renders and the file formats download', async ({ page }) => {
    await page.goto('/app.html');
    await waitForApp(page);
    const fmts = await page.evaluate(() => ExportDialog.FORMATS.map((f) => f.id));
    expect(fmts).toEqual(expect.arrayContaining(['geojson', 'json', 'csv', 'png', 'glb']));
    const open = () => page.evaluate(([cell, data]) => ExportDialog.open(cell, data), [SAMPLE_CELL, SAMPLE_DATA]);

    // Every tab renders a description and at least one content line.
    await open();
    for (const id of fmts) {
      await page.click(`.ed-tab[data-fmt="${id}"]`);
      await expect(page.locator('.ed-desc')).not.toBeEmpty();
      expect(await page.locator('.ed-item').count()).toBeGreaterThan(0);
      await expect(page.locator('.ed-filename')).toContainText(CELL.replace(/-/g, '')
        .slice(0, 3), { ignoreCase: true });
    }
    await page.click('.ed-close');

    // The data formats produce a real download with the right extension.
    for (const [id, ext] of [['geojson', '.geojson'], ['json', '.json'], ['csv', '.csv']]) {
      await open();
      await page.click(`.ed-tab[data-fmt="${id}"]`);
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        page.click('.ed-export-btn'),
      ]);
      expect(dl.suggestedFilename()).toMatch(new RegExp(`${ext.replace('.', '\\.')}$`));
    }
    // Map-dependent formats must not throw even with nothing to export.
    for (const id of ['png', 'glb']) {
      await open();
      await page.click(`.ed-tab[data-fmt="${id}"]`);
      await page.click('.ed-export-btn');
      await page.waitForTimeout(500);
    }
  });

  test('share link round trip restores layers, zoom and position', async ({ page }) => {
    test.setTimeout(300_000);   // 89 s seen alongside the soak (same software-GL contention as above)
    await page.goto('/app.html');
    await waitForApp(page);
    await toggleRow(page, 'btn-3d');
    await toggleRow(page, 'btn-terrain');
    await page.evaluate(() => MapModule.flyTo(22.72, 75.86, 15));
    await settle(page, 1200);
    const url = await page.evaluate(() => URLState.buildUrl(URLState.capture()));
    expect(url).toContain('layers=');
    expect(url).toContain('ll=');
    const expectLayers = await page.evaluate(() => URLState.activeLayers());

    await page.goto(url);
    await waitForApp(page);
    await settle(page, 2000);
    await expect.poll(() => page.evaluate(() => URLState.activeLayers()), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(expectLayers));
    const st = await page.evaluate(() => URLState.capture());
    expect(Math.abs(st.ll.lat - 22.72)).toBeLessThan(0.01);
    expect(Math.abs(st.ll.lng - 75.86)).toBeLessThan(0.01);
    // The share button itself copies (or prompts) without throwing.
    await page.evaluate(() => { window.prompt = () => null; });
    await page.click('#share-btn');
  });
});
