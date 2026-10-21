// Agents gallery: pick an agent, see the plan, run it, get a report + layer,
// reopen it from My runs, and re-run it from a share link.
//
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { prepare, waitForApp, settle } = require('./helpers/app');

const CELL = '34P-LL5-4L7';

test.describe('agents', () => {
  let errors = [];
  test.beforeEach(async ({ page }) => { errors = await prepare(page); });
  test.afterEach(() => { expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]); });

  test('plan, run, report, layer, saved run and share link', async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.goto('/app.html');
    await waitForApp(page);
    await page.evaluate((c) => MapModule.selectByCode(c), CELL);
    await settle(page, 600);

    await page.click('#btn-agents');
    const dlg = page.locator('#agents-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.ag-card')).toHaveCount(7);

    // Setup shows the plan before anything runs.
    await dlg.locator('.ag-card[data-agent="site"]').click();
    await expect(dlg.locator('.ag-area')).toContainText('Neighbourhood 34P-LL');
    await dlg.getByRole('button', { name: 'School' }).click();
    await expect(dlg.locator('.ag-plan .ag-step')).toHaveCount(4);
    await expect(dlg.locator('.ag-plan')).toContainText('school');

    await dlg.getByRole('button', { name: 'Run agent' }).click();
    await expect(dlg.locator('.ag-summary')).toContainText('best school site', { timeout: 60_000 });
    await expect(dlg.locator('.ui-finding').first()).toBeVisible();
    expect(await page.evaluate(() => CellLayers.isVisible('agent_site'))).toBe(true);

    // Saved in My runs, and reopens.
    const runs = await page.evaluate(() => AgentsPanel.savedRuns().map((r) => r.agent));
    expect(runs).toEqual(['site']);
    await dlg.getByRole('tab', { name: 'My runs' }).click();
    await expect(dlg.locator('.ag-run-row')).toHaveCount(1);
    await dlg.locator('.ag-run-open').click();
    await expect(dlg.locator('.ag-summary')).toContainText('best school site');

    // A share link re-runs the same agent on the same area in a fresh page.
    const url = await page.evaluate(() => AgentsPanel.shareLink());
    expect(url).toContain('ag=site');
    expect(url).toContain('ap=use%3Aschool');
    const p2 = await context.newPage();
    const e2 = await prepare(p2);
    await p2.goto(url.replace(/^https?:\/\/[^/]+/, ''));
    await waitForApp(p2);
    await expect(p2.locator('#agents-dialog .ag-summary')).toContainText('best school site', { timeout: 60_000 });
    expect(e2).toEqual([]);
  });

  test('every agent runs on the whole city without errors', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/app.html');
    await waitForApp(page);
    const out = await page.evaluate(async () => {
      const res = [];
      for (const t of UrbanAgents.TEMPLATES) {
        try {
          const { report } = await UrbanAgents.run({ agent: t.id, area: { city: 'indore_pilot' }, params: {} });
          res.push([t.id, !!report.summary, report.steps.filter((s) => s.status === 'failed').length]);
        } catch (e) { res.push([t.id, false, String(e.message)]); }
      }
      return res;
    });
    for (const [id, ok, failed] of out) expect([id, ok, failed]).toEqual([id, true, 0]);
  });
});
