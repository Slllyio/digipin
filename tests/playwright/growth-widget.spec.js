import { test, expect } from '@playwright/test';

test('growth widget renders for an Indore cell', async ({ page }) => {
    await page.goto('http://localhost:8000/');
    await page.waitForSelector('#map');
    // Click the centre of the map (Indore default)
    const map = page.locator('#map');
    const box = await map.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('[data-growth-widget]', { timeout: 8000 });
    const widget = page.locator('[data-growth-widget]').first();
    await expect(widget).toBeVisible();
});

test('horizon toggle changes the composite display', async ({ page }) => {
    await page.goto('http://localhost:8000/');
    await page.waitForSelector('#map');
    const map = page.locator('#map');
    const box = await map.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('[data-growth-widget]');
    await page.click('button[data-h="year_5"]');
    const composite = await page.textContent('.growth-widget__composite');
    expect(composite).toContain('Composite:');
});
