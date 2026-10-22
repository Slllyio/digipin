// Live now (weather, air, river, correlations) and Live sky (aircraft in 3D).
// The upstream feeds are stubbed so the run is deterministic: a heavy-rain
// day over Delhi with a rising river, and a handful of aircraft around the
// view centre. PW_LIVE_REAL=1 lets Open-Meteo / USGS / EONET through (local
// check against the real feeds); ADSB_FIXTURE=<file> serves a recorded
// adsb.lol response instead of the synthetic aircraft. PW_SHOTS=<dir> saves
// screenshots.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { STUB, prepare, waitForApp, settle, toggleRow } = require('./helpers/app');

const REAL = process.env.PW_LIVE_REAL === '1';
const SHOTS = process.env.PW_SHOTS || '';
const CORS = { 'access-control-allow-origin': '*' };

test.use({ serviceWorkers: 'block' });

function forecast() {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const days = [0, 1, 2].map((k) => new Date(Date.parse(`${today}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10));
  return {
    current: { time: `${today}T14:00`, temperature_2m: 27.4, relative_humidity_2m: 88, apparent_temperature: 31.2, precipitation: 3.1, weather_code: 63, wind_speed_10m: 14, is_day: 1 },
    daily: {
      time: days, temperature_2m_max: [29.1, 28.4, 30.2], temperature_2m_min: [24, 23.5, 24.1],
      precipitation_sum: [22.5, 92.4, 8], precipitation_probability_max: [90, 95, 60], weather_code: [63, 65, 61],
    },
  };
}

function flood(url) {
  const n = new URL(url).searchParams.get('latitude').split(',').length;
  const time = []; const t0 = Date.now() - 30 * 864e5;
  for (let k = 0; k < 37; k++) time.push(new Date(t0 + k * 864e5).toISOString().slice(0, 10));
  return Array.from({ length: n }, (_, i) => ({
    latitude: 28.5 + i * 0.001, longitude: 77.3,
    daily: { time, river_discharge: time.map((_, k) => (i === 10 ? (k < 30 ? 300 : 300 + (k - 29) * 120) : 2)) },
  }));
}

function aircraft(url) {
  if (process.env.ADSB_FIXTURE) {
    const j = JSON.parse(fs.readFileSync(process.env.ADSB_FIXTURE, 'utf8'));
    return { ...j, now: Date.now() };
  }
  const m = new URL(url).pathname.match(/point\/([-\d.]+)\/([-\d.]+)/);
  const lat = +m[1], lng = +m[2];
  const ac = [
    [0.04, 0.02, 1800, 180, 'IGO201'], [-0.05, 0.06, 3500, 90, 'AIC433'], [0.1, -0.08, 9800, 300, 'UAE15'],
    [-0.02, -0.03, 600, 270, 'AKJ1102'], [0.03, -0.12, 'ground', 0, 'VT-XYZ'],
  ].map(([dy, dx, alt, track, flight], i) => ({
    hex: `80aa0${i}`, flight, r: `VT-AA${i}`, t: 'A20N', alt_baro: alt, alt_geom: alt === 'ground' ? undefined : alt * 3.28,
    gs: alt === 'ground' ? 0 : 280, track, lat: lat + dy, lon: lng + dx, seen_pos: 0.5,
  }));
  return { now: Date.now(), ac };
}

async function stubFeeds(page) {
  await page.route(/api\.adsb\.lol/, (r) => r.fulfill({ json: aircraft(r.request().url()), headers: CORS }));
  if (REAL) return;
  await page.route(/api\.open-meteo\.com/, (r) => r.fulfill({ json: forecast(), headers: CORS }));
  await page.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill({ json: { current: { time: 't', pm2_5: 142, pm10: 260, nitrogen_dioxide: 60, ozone: 40 } }, headers: CORS }));
  await page.route(/flood-api\.open-meteo\.com/, (r) => r.fulfill({ json: flood(r.request().url()), headers: CORS }));
  await page.route(/earthquake\.usgs\.gov/, (r) => r.fulfill({ json: { features: [{ id: 'us7000x', geometry: { coordinates: [78.1, 29.9, 10] }, properties: { mag: 4.6, place: 'Uttarakhand, India', time: Date.now() - 864e5 } }] }, headers: CORS }));
  await page.route(/eonet\.gsfc\.nasa\.gov/, (r) => r.fulfill({ json: { events: [] }, headers: CORS }));
}

async function closeLayers(page) {
  if (await page.locator('#dt-layers-dropdown').isVisible()) await page.click('#btn-dt-layers');
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe('live feeds', () => {
  let errors = [];
  test.beforeEach(async ({ page }) => { errors = await prepare(page); await stubFeeds(page); });
  test.afterEach(() => { expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]); });

  test('Live now shows weather, air, river and correlations for the view', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/app.html');
    await waitForApp(page);
    await page.selectOption('#city-select', 'delhi');
    await settle(page, 600);
    await toggleRow(page, 'btn-livenow');
    await closeLayers(page);
    const panel = page.locator('#live-now-panel');
    await expect(panel.locator('.ln-checks')).toBeVisible({ timeout: 45_000 });
    if (!REAL) {
      await expect(panel.locator('.ln-temp')).toHaveText('27°');
      await expect(panel.locator('.ln-aqi').first()).toHaveText(/^\d+$/);
      await expect(panel).toContainText('AQI · Very Poor');
      const titles = await panel.locator('.ln-c strong').allTextContents();
      expect(titles.join('|')).toMatch(/Heavy rain .*92 mm/);
      expect(titles.join('|')).toMatch(/River flow rising/);
      expect(titles.join('|')).toMatch(/M4\.6 earthquake/);
      await expect(page.locator('#btn-livenow .tb-badge')).toHaveText(String(titles.length));
    }
    await shot(page, 'live-now');
    // A correlation with cells paints them on the map.
    const rain = panel.locator('.ln-c', { hasText: 'rain' }).first();
    if (await rain.count()) {
      await rain.locator('button').click();
      if (!STUB) {
        expect(await page.evaluate(() => LiveNow.shownCells())).toBeGreaterThan(0);
        expect(await page.evaluate(() => !!MapModule.getMap().getLayer('live-now-cells'))).toBe(true);
      }
      await settle(page, 600);
      await shot(page, 'live-now-flood-cells');
    }
    await panel.locator('button[aria-label="Close live panel"]').click();
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => LayersPanel.isActive('btn-livenow'))).toBe(false);
  });

  test('Live sky draws aircraft in 3D at altitude', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/app.html');
    await waitForApp(page);
    await page.selectOption('#city-select', 'delhi');
    await settle(page, 600);
    await page.evaluate(() => MapModule.getMap().jumpTo({ center: [77.12, 28.58], zoom: 10.6, pitch: 62, bearing: -25 }));
    await toggleRow(page, 'btn-livesky');
    await closeLayers(page);
    const status = page.locator('.live-sky-status');
    await expect(status).toContainText(/\d+ aircraft in the air/, { timeout: 20_000 });
    expect(await page.evaluate(() => LiveSky.aircraft().length)).toBeGreaterThan(0);
    if (!STUB) {
      const z = await page.evaluate(() => new Promise((res) => setTimeout(() => {
        const f = (LiveSky.lastFrame() || { planes: { features: [] } }).planes.features;
        res(f.filter((x) => x.properties.part === 'plane').map((x) => x.properties.base));
      }, 600)));
      expect(await page.evaluate(() => !!MapModule.getMap().getLayer('live-sky-planes'))).toBe(true);
      expect(z.length).toBeGreaterThan(0);
      expect(Math.max(...z)).toBeGreaterThan(300);
    }
    await toggleRow(page, 'btn-buildings');
    await closeLayers(page);
    await settle(page, 1500);
    await shot(page, 'live-sky-3d');
    await status.locator('select').selectOption('0.25');
    await settle(page, 800);
    await shot(page, 'live-sky-3d-compressed');
    await toggleRow(page, 'btn-livesky');
    await expect(status).toHaveCount(0);
  });
});
