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

function wiki(url) {
  const at = new URL(url).searchParams.get('ggscoord');
  if (!at) return { query: { pages: [] } };   // other Wikipedia calls the app makes
  const [lat, lng] = at.split('|').map(Number);
  const pages = [
    ['Red Fort', 'Historic fort in Delhi, India', 0.012, 0.01],
    ['Jama Masjid', 'Mosque in Delhi', -0.01, 0.006],
    ['Lodhi Garden', 'Urban park in New Delhi', -0.02, -0.012],
    ['Rajiv Chowk metro station', 'Metro station in New Delhi', 0.004, -0.004],
  ].map(([title, description, dy, dx], i) => ({
    pageid: 100 + i, index: i + 1, title, description, fullurl: `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`,
    coordinates: [{ lat: lat + dy, lon: lng + dx, dist: Math.round(Math.hypot(dy, dx) * 111000) }],
  }));
  return { query: { pages } };
}

// Recorded CelesTrak elements, re-dated to 12 h ago so they never look stale.
function celestrak() {
  const epoch = new Date(Date.now() - 12 * 3600e3).toISOString().slice(0, 23);
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'celestrak-gp.json'), 'utf8')).map((r) => ({ ...r, EPOCH: epoch }));
}

function clouds() {
  const t0 = Math.floor(Date.now() / 3600e3) * 3600e3;
  const time = []; const cloud = [];
  for (let k = 0; k < 7 * 24; k++) { time.push(new Date(t0 + k * 3600e3).toISOString().slice(0, 16)); cloud.push(k % 48 < 24 ? 15 : 85); }
  return { hourly: { time, cloud_cover: cloud } };
}

async function stubFeeds(page) {
  await page.route(/api\.adsb\.lol/, (r) => r.fulfill({ json: aircraft(r.request().url()), headers: CORS }));
  if (REAL) return;
  await page.route(/wikipedia\.org\/w\/api\.php/, (r) => r.fulfill({ json: wiki(r.request().url()), headers: CORS }));
  await page.route(/celestrak\.org/, (r) => r.fulfill({ json: /GROUP=stations/.test(r.request().url()) ? celestrak().filter((x) => /ISS/.test(x.OBJECT_NAME)) : celestrak().filter((x) => !/ISS/.test(x.OBJECT_NAME)), headers: CORS }));
  await page.route(/api\.open-meteo\.com/, (r) => r.fulfill({ json: /hourly=cloud_cover/.test(r.request().url()) ? clouds() : forecast(), headers: CORS }));
  await page.route(/air-quality-api\.open-meteo\.com/, (r) => r.fulfill({ json: { current: { time: 't', pm2_5: 142, pm10: 260, nitrogen_dioxide: 60, ozone: 40 } }, headers: CORS }));
  await page.route(/flood-api\.open-meteo\.com/, (r) => r.fulfill({ json: flood(r.request().url()), headers: CORS }));
  await page.route(/earthquake\.usgs\.gov/, (r) => r.fulfill({ json: { features: [{ id: 'us7000x', geometry: { coordinates: [78.1, 29.9, 10] }, properties: { mag: 4.6, place: 'Uttarakhand, India', time: Date.now() - 864e5 } }] }, headers: CORS }));
  await page.route(/services\.swpc\.noaa\.gov/, (r) => r.fulfill({ json: [{ time_tag: new Date(Date.now() - 3600e3).toISOString().slice(0, 19), kp: 6.33, observed: 'estimated' }], headers: CORS }));
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
      expect(titles.join('|')).toMatch(/GPS accuracy degraded: geomagnetic storm \(Kp 6\)/);
      await expect(panel).toContainText('GPS field accuracy · Caution');
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
    // Live count beside the layer (Aino Layers card on wide light screens, else the menu row).
    await expect(page.locator('.ar-row[data-ar-key="_btn_btn-livesky"] .layer-count, .dt-layer-item[data-layer-key="_btn_btn-livesky"] .layer-count').first())
      .toHaveText(/^\d+$/, { timeout: 10_000 });
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
    await page.fill('#search-input', 'aic433');
    await page.press('#search-input', 'Enter');
    if (!STUB && !process.env.ADSB_FIXTURE) await expect(page.locator('.live-sky-pop')).toContainText('AIC433');
    await status.locator('select').selectOption('0.25');
    await settle(page, 800);
    await shot(page, 'live-sky-3d-compressed');
    await toggleRow(page, 'btn-livesky');
    await expect(status).toHaveCount(0);
  });

  test('Places pins Wikipedia places with their DIGIPIN and opens the cell', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/app.html');
    await waitForApp(page);
    await page.selectOption('#city-select', 'delhi');
    await settle(page, 600);
    await page.evaluate(() => MapModule.getMap().jumpTo({ center: [77.225, 28.64], zoom: 13.2, pitch: 0 }));
    await toggleRow(page, 'btn-places');
    await closeLayers(page);
    await page.waitForFunction(() => PlacesNearby.places().length > 0, null, { timeout: 20_000 });
    const places = await page.evaluate(() => PlacesNearby.places());
    expect(places.every((p) => /^[2-9CFJKLMPT]{3}-[2-9CFJKLMPT]{3}-[2-9CFJKLMPT]{4}$/.test(p.digipin))).toBe(true);
    await expect(page.locator('.ar-row[data-ar-key="_btn_btn-places"] .layer-count, .dt-layer-item[data-layer-key="_btn_btn-places"] .layer-count').first())
      .toHaveText(String(places.length), { timeout: 10_000 });
    if (!STUB) {
      await settle(page, 800);
      const target = places[0];
      const pt = await page.evaluate((p) => { const m = MapModule.getMap(); const q = m.project([p.lng, p.lat]); const r = m.getCanvas().getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; }, target);
      await page.mouse.click(pt.x, pt.y);
      const card = page.locator('.places-card');
      await expect(card).toContainText(target.title);
      await expect(card).toContainText(`DIGIPIN ${target.digipin}`);
      await shot(page, 'places-card');
      await card.getByRole('button', { name: 'Open this cell' }).click();
      await expect.poll(() => page.evaluate(() => MapModule.getSelectedCode())).toBeTruthy();
    }
    // The map search finds places on the layer before asking the geocoder.
    await page.fill('#search-input', 'jama masjid');
    await page.press('#search-input', 'Enter');
    if (!STUB) await expect(page.locator('.places-card')).toContainText('Jama Masjid');
    await toggleRow(page, 'btn-places');
    expect(await page.evaluate(() => PlacesNearby.isActive())).toBe(false);
  });

  test('Satellite passes lists the next imaging passes with clouds and draws the swath', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/app.html');
    await waitForApp(page);
    await page.selectOption('#city-select', 'delhi');
    await settle(page, 600);
    await page.evaluate(() => MapModule.getMap().jumpTo({ center: [77.21, 28.61], zoom: 10, pitch: 0 }));
    await toggleRow(page, 'btn-satpasses');
    await closeLayers(page);
    await page.waitForFunction(() => SatPasses.rows().length > 0, null, { timeout: 20_000 });
    const rows = await page.evaluate(() => SatPasses.rows());
    // Sorted soonest first, within the week, each with an outlook.
    expect(rows.map((r) => r.t)).toEqual([...rows.map((r) => r.t)].sort((a, b) => a - b));
    expect(rows.every((r) => r.t > Date.now() && r.t < Date.now() + 7.1 * 864e5)).toBe(true);
    // Fixture epochs are re-dated to now, so which satellites pass depends on the hour; the wide-swath daily ones always do.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.meta.kind === 'optical')).toBe(true);
    expect(rows.filter((r) => r.meta.kind === 'optical').every((r) => /cloud|forecast/.test(r.outlook))).toBe(true);
    expect(rows.find((r) => r.meta.kind === 'sar')?.outlook || 'Radar').toMatch(/Radar/);
    const panel = page.locator('#sat-passes-panel');
    await expect(panel).toContainText('Satellite passes over this view');
    await expect(panel.locator('.sat-list li')).toHaveCount(rows.length);
    const fleet = await page.evaluate(() => SatPasses.satellites().length);
    if (!REAL) expect(fleet).toBe(11);
    await expect(page.locator('.ar-row[data-ar-key="_btn_btn-satpasses"] .layer-count, .dt-layer-item[data-layer-key="_btn_btn-satpasses"] .layer-count').first())
      .toHaveText(String(fleet), { timeout: 10_000 });
    // Positions and tracks are drawn; picking a pass adds its swath.
    await expect.poll(() => page.evaluate(() => SatPasses.lastFrame()?.pos), { timeout: 10_000 }).toBe(fleet);
    await panel.locator('.sat-list li button').first().click();
    await expect(panel.locator('.sat-list li.is-selected')).toHaveCount(1);
    await settle(page, 1200);
    await expect.poll(() => page.evaluate(() => SatPasses.lastFrame()?.swath), { timeout: 10_000 }).toBe(1);
    await shot(page, 'sat-passes');
    await toggleRow(page, 'btn-satpasses');
    expect(await page.evaluate(() => SatPasses.isActive())).toBe(false);
    await expect(panel).toHaveCount(0);
  });

  test('Sentinel-2 card shows when the next Sentinel-2 pass is due', async ({ page }) => {
    test.setTimeout(90_000);
    await page.route(/planetarycomputer\.microsoft\.com\/api\/stac/, (r) => r.fulfill({ json: { features: [
      { id: 'S2B_MSIL2A_TEST', bbox: [76.5, 28, 77.8, 29.1], properties: { datetime: new Date(Date.now() - 4 * 864e5).toISOString(), 'eo:cloud_cover': 3.2 } },
    ] }, headers: CORS }));
    await page.route(/planetarycomputer\.microsoft\.com\/api\/data/, (r) => r.fulfill({ status: 204, headers: CORS }));
    // Real element epochs and a pinned clock make the pass deterministic: SGP4 puts
    // Sentinel-2A over Delhi at 2026-10-22 05:41 UTC (11:11 IST).
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'celestrak-gp.json'), 'utf8'));
    await page.route(/celestrak\.org/, (r) => r.fulfill({ json: /GROUP=stations/.test(r.request().url()) ? [] : fixture, headers: CORS }));
    await page.clock.setFixedTime(new Date('2026-10-21T20:00:00Z'));
    await page.goto('/app.html');
    await waitForApp(page);
    await page.selectOption('#city-select', 'delhi');
    await settle(page, 600);
    await page.evaluate(() => SentinelImagery.attach());
    const next = page.locator('#sentinel-panel .sentinel-next, .sentinel-panel .sentinel-next').first();
    await expect(next).toBeVisible({ timeout: 20_000 });
    await expect(next).toContainText('Next pass: Sentinel-2A, Thu 22 Oct, 11:11 IST');
    await page.evaluate(() => SentinelImagery.detach());
  });

  test('DISHA answers "when is the next satellite pass" from the orbit model', async ({ page }) => {
    test.setTimeout(90_000);
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'celestrak-gp.json'), 'utf8'));
    await page.route(/celestrak\.org/, (r) => r.fulfill({ json: /GROUP=stations/.test(r.request().url()) ? [] : fixture, headers: CORS }));
    await page.clock.setFixedTime(new Date('2026-10-21T20:00:00Z'));
    await page.goto('/app.html');
    await waitForApp(page);
    await page.evaluate(() => {
      const code = DigiPin.encode(28.6139, 77.209);
      DISHAPanel.open({ code, center: { lat: 28.6139, lng: 77.209 } }, {});
    });
    await page.fill('#disha-input', 'When will Sentinel-2 next image this block?');
    await page.press('#disha-input', 'Enter');
    const msgs = page.locator('#disha-messages');
    await expect(msgs).toContainText('Next satellite passes', { timeout: 20_000 });
    await expect(msgs).toContainText('Sentinel-2A is next');
    await expect(msgs).toContainText('Thu 22 Oct, 11:11 IST');
    await shot(page, 'disha-sat-passes');
  });

  test('DISHA answers "what is happening here right now" from the live feeds', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/app.html');
    await waitForApp(page);
    await page.selectOption('#city-select', 'delhi');
    await settle(page, 600);
    await page.evaluate(() => MapModule.getMap().jumpTo({ center: [77.3, 28.55], zoom: 11, pitch: 0 }));
    await page.evaluate(() => {
      const code = DigiPin.encode(28.55, 77.3);
      DISHAPanel.open({ code, center: { lat: 28.55, lng: 77.3 } }, {});
    });
    await page.fill('#disha-input', "What's happening here right now?");
    await page.press('#disha-input', 'Enter');
    const msgs = page.locator('#disha-messages');
    await expect(msgs).toContainText('Live now ·', { timeout: 30_000 });
    if (!REAL) {
      await expect(msgs).toContainText(/things? in the live feeds line/);
      await expect(msgs).toContainText(/AQI \d+ \(Very Poor\)/);
      await expect(msgs).toContainText(/M4\.6/);
    }
    await shot(page, 'disha-live-now');
  });

  test('a share link reopens with the live layers on', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/app.html?ll=28.61,77.21&z=11&layers=livenow,satpasses,places');
    await waitForApp(page);
    await expect.poll(() => page.evaluate(() => [LiveNow.isActive(), SatPasses.isActive(), PlacesNearby.isActive()]), { timeout: 20_000 })
      .toEqual([true, true, true]);
    await expect(page.locator('#sat-passes-panel')).toBeVisible();
    // And the current view writes them back into the link.
    const tokens = await page.evaluate(() => URLState.activeLayers());
    expect(tokens).toEqual(expect.arrayContaining(['livenow', 'satpasses', 'places']));
  });
});

