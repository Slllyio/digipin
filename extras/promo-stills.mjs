/**
 * promo-stills.mjs — capture a deterministic set of 1080p promo frames from the
 * REAL app (each composed + captioned), to be assembled into a video by
 * extras/build-promo.sh (ffmpeg crossfade + gentle zoom).
 *
 * Stills approach (not real-time screen capture) because headless software-GL
 * makes real-time recording drift; here every scene is framed, settled, and
 * shot deterministically — including zooming to the Text2Map result cells so
 * the highlight is clearly visible.
 *
 * Run:  node extras/promo-stills.mjs      Out: extras/out/NN-*.png
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(__dirname, 'out');
const PORT = 8099;
const BASE = `http://localhost:${PORT}/app.html`;
const C = { lng: 75.8577, lat: 22.7196 };
/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until MapModule's map exists and has finished loading, then settle. */
async function waitForMap(page) {
    await page.waitForFunction(() => (
        typeof MapModule !== 'undefined' && MapModule.getMap
        && MapModule.getMap() && MapModule.getMap().loaded()
    ), { timeout: 45000 });
    await sleep(4500);
}

/** Inject the burned-in caption overlay (title/lower-third/badge) and its window helpers. */
async function injectOverlay(page) {
    await page.evaluate(() => {
        document.getElementById('promo-cap')?.remove();
        const wrap = document.createElement('div');
        wrap.id = 'promo-cap';
        wrap.innerHTML = '<div id="promo-title"></div>'
            + '<div id="promo-lower"><div id="promo-h"></div><div id="promo-s"></div></div>'
            + '<div id="promo-badge">DigiPin · Urban Intelligence</div>';
        const css = document.createElement('style');
        css.textContent = `
          #promo-cap{position:fixed;inset:0;z-index:99999;pointer-events:none;
            font-family:Inter,system-ui,sans-serif}
          #promo-title{position:absolute;top:46%;left:50%;transform:translate(-50%,-50%);
            text-align:center;font-size:72px;font-weight:800;letter-spacing:-1.5px;color:#fff;
            text-shadow:0 6px 40px rgba(0,0,0,.6);max-width:80%;white-space:pre-line;line-height:1.04}
          #promo-lower{position:absolute;left:60px;bottom:70px;max-width:62%}
          #promo-h{font-size:40px;font-weight:800;color:#fff;letter-spacing:-.5px;
            text-shadow:0 3px 20px rgba(0,0,0,.7);margin-bottom:8px}
          #promo-s{font-size:23px;font-weight:500;color:#eef2f6;line-height:1.45;
            text-shadow:0 2px 16px rgba(0,0,0,.8)}
          #promo-badge{position:absolute;top:30px;left:60px;font-size:18px;font-weight:700;
            letter-spacing:.5px;color:#fff;background:rgba(221,107,74,.95);padding:9px 18px;
            border-radius:999px;box-shadow:0 8px 28px rgba(0,0,0,.35)}`;
        document.head.appendChild(css);
        document.body.appendChild(wrap);
        window.__title = (t) => { document.getElementById('promo-title').textContent = t || ''; };
        window.__cap = (h, s) => {
            document.getElementById('promo-h').textContent = h || '';
            document.getElementById('promo-s').textContent = s || '';
        };
    });
}

/** Set the big centred title-card text `t` on the overlay. */
const title = (p, t) => p.evaluate((t) => window.__title(t), t);
/** Clear the title and set the lower-third heading `h` and subtitle `s`. */
const cap = (p, h, s) => p.evaluate(([h, s]) => { window.__title(''); window.__cap(h, s); }, [h, s]);
/** Snap the map instantly to camera options `o`. */
const jump = (p, o) => p.evaluate((o) => MapModule.getMap().jumpTo(o), o);

/** Toggle the Overture 3D buildings overlay to the desired `on` state, then let it stream in. */
async function buildings(page, on) {
    await page.evaluate((on) => {
        if (typeof OvertureBuildings === 'undefined'
            || typeof OvertureBuildings.isActive !== 'function'
            || typeof OvertureBuildings.toggle !== 'function') return;
        if (on !== OvertureBuildings.isActive()) OvertureBuildings.toggle(MapModule.getMap());
    }, on);
    await sleep(2500); // let extrusions stream in
}
// Build our OWN choropleth from PrecomputedScores.lookupViewport (verified
// 0–100 scores) — the shipped scores.pmtiles renders geometry with empty
// properties in this pilot, so the built-in ScoreChoropleth shows a flat wash.
// Coloured cell rectangles via DigiPin.decode(code).bounds. Returns {n,min,max}.
async function paintScores(page, key) {
    const r = await page.evaluate(async (key) => {
        const m = MapModule.getMap();
        const bb = m.getBounds();
        const bounds = { south: bb.getSouth(), west: bb.getWest(), north: bb.getNorth(), east: bb.getEast() };
        const cells = await PrecomputedScores.lookupViewport(bounds);
        if (!cells || !cells.length) return { n: 0 };
        const feats = []; const vals = [];
        for (const c of cells) {
            const b = c.bounds; // precomputed cells carry their own cell bounds
            if (!b) continue;
            const s = c.scores ? c.scores[key] : null;
            const v = Number(s && typeof s === 'object' ? s.value : s);
            if (!isFinite(v)) continue;
            vals.push(v);
            feats.push({
                type: 'Feature',
                properties: { v },
                geometry: { type: 'Polygon', coordinates: [[
                    [b.west, b.south], [b.east, b.south], [b.east, b.north],
                    [b.west, b.north], [b.west, b.south]]] },
            });
        }
        const fc = { type: 'FeatureCollection', features: feats };
        const SRC = 'promo-choro-src', FILL = 'promo-choro-fill', LINE = 'promo-choro-line';
        for (const id of [LINE, FILL]) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(SRC)) m.removeSource(SRC);
        m.addSource(SRC, { type: 'geojson', data: fc });
        m.addLayer({
            id: FILL, type: 'fill', source: SRC,
            paint: {
                'fill-color': ['step', ['get', 'v'],
                    '#d7301f', 30, '#ef6548', 45, '#fdae61', 60, '#a6d96a', 75, '#1a9850'],
                'fill-opacity': 0.62,
            },
        });
        m.addLayer({
            id: LINE, type: 'line', source: SRC,
            paint: { 'line-color': 'rgba(255,255,255,0.18)', 'line-width': 0.6 },
        });
        return { n: feats.length, min: Math.min(...vals), max: Math.max(...vals) };
    }, key);
    return r;
}
/** Remove the choropleth layers + source added by paintScores. */
async function clearScores(page) {
    await page.evaluate(() => {
        const m = MapModule.getMap();
        for (const id of ['promo-choro-line', 'promo-choro-fill']) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource('promo-choro-src')) m.removeSource('promo-choro-src');
    });
}
/** Capture a 1080p screenshot of the current page to OUT/`name`. */
async function shot(page, name) { await page.screenshot({ path: join(OUT, name), timeout: 20000 }); }

/** Serve the app, launch a headless browser, and capture the full light+dark still sequence. */
async function main() {
    // Only clear this script's own still frames — siblings (narration/, clips/,
    // _seg/, the rendered MP4s) share extras/out and must survive.
    mkdirSync(OUT, { recursive: true });
    for (const name of readdirSync(OUT)) {
        if (name.toLowerCase().endsWith('.png')) rmSync(join(OUT, name), { force: true });
    }
    const server = spawn('python3', ['serve.py', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
    let browser;
    let context;
    try {
        await sleep(2500);
        browser = await chromium.launch({
            headless: true,
            args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
                '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
        });
        context = await browser.newContext({
            viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true,
        });
        await context.addInitScript(() => { try { localStorage.setItem('digipin_onboarded', 'done'); } catch (e) { void e; } });
        await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
        const page = await context.newPage();
        page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 160)); });
        // ---------- LIGHT (Paper) ----------
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await waitForMap(page);
        await injectOverlay(page);

        await jump(page, { center: [C.lng, C.lat], zoom: 12.6, pitch: 0, bearing: 0 });
        await sleep(2500);
        await title(page, 'DigiPin\nUrban Intelligence');
        await shot(page, '01-title.png');

        await jump(page, { center: [C.lng, C.lat], zoom: 13.5 });
        await sleep(2500);
        await cap(page, 'A grid for every street',
            'India mapped into uniquely addressable DIGIPIN cells — each enriched with real urban data.');
        await shot(page, '02-grid.png');

        await jump(page, { center: [C.lng, C.lat], zoom: 13.7 });
        console.log('livability', JSON.stringify(await paintScores(page, 'livability')));
        await sleep(1800);
        await cap(page, 'Livability score',
            'Every cell scored 0–100 — green = safer, greener, healthier, quieter. A great place to live.');
        await shot(page, '03-livability.png');

        console.log('walkability', JSON.stringify(await paintScores(page, 'walkability')));
        await sleep(1500);
        await cap(page, '20 scores per cell',
            'Walkability — how much you can reach on foot. Swap in any of 20 urban metrics.');
        await shot(page, '04-walkability.png');

        console.log('commercial', JSON.stringify(await paintScores(page, 'commercial')));
        await sleep(1500);
        await cap(page, 'Commercial activity',
            'Shops, offices and footfall per cell — find the busy cores and the quiet gaps.');
        await shot(page, '05-commercial.png');
        await clearScores(page);

        await jump(page, { center: [C.lng, C.lat], zoom: 15.7, pitch: 60, bearing: -26 });
        await sleep(1500);
        await buildings(page, true);
        await sleep(1500);
        await cap(page, '3D buildings · Paper',
            'Every footprint extruded to its real height — a clean architectural model of the city.');
        await shot(page, '06-light-3d.png');
        await buildings(page, false);

        await jump(page, { center: [C.lng, C.lat], zoom: 13.4, pitch: 0, bearing: 0 });
        await sleep(1500);
        await cap(page, 'Two themes', 'One system, two looks — switching to the dark control-room theme.');
        await shot(page, '07-twothemes.png');

        // ---------- DARK ----------
        await page.evaluate(() => { try { localStorage.setItem('digipin_theme', 'dark'); } catch (e) { void e; } });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForMap(page);
        await injectOverlay(page);

        await jump(page, { center: [C.lng, C.lat], zoom: 13.5, pitch: 0, bearing: 0 });
        await sleep(2500);
        await cap(page, 'Dark control-room', 'Neon grid on deep navy — the same data, a different mood.');
        await shot(page, '08-dark-grid.png');

        console.log('dark livability', JSON.stringify(await paintScores(page, 'livability')));
        await sleep(1800);
        await cap(page, 'Scores, reimagined', 'The same livability scores, glowing on the dark canvas.');
        await shot(page, '09-dark-scores.png');
        await clearScores(page);

        await jump(page, { center: [C.lng, C.lat], zoom: 16.8, pitch: 56, bearing: 24 });
        await sleep(1500);
        await buildings(page, true);
        await sleep(1500);
        await cap(page, '3D buildings · Dark',
            'In dark mode the same buildings become a neon, holographic skyline.');
        await shot(page, '10-dark-3d.png');
        await buildings(page, false);

        // ---------- Text2Map ----------
        await jump(page, { center: [C.lng, C.lat], zoom: 13.0, pitch: 0, bearing: 0 });
        await sleep(1500);
        const fit = await page.evaluate(async () => {
            const m = MapModule.getMap();
            const bb = m.getBounds();
            const bounds = { south: bb.getSouth(), west: bb.getWest(), north: bb.getNorth(), east: bb.getEast() };
            const out = await Text2Map.run('family-friendly area near good schools with low flood risk', bounds, () => {});
            if (!out || !out.results || !window.Text2MapResultsLayer) return -1;
            const n = Text2MapResultsLayer.show(out.results);
            return n;
        });
        console.log('text2map cells drawn:', fit);
        await sleep(3000); // let fitBounds settle on the result cells
        await cap(page, 'Ask in plain English',
            '“family-friendly area, good schools, low flood risk” → the best DIGIPIN cells, ranked on the map.');
        await shot(page, '11-text2map.png');

        await page.evaluate(() => { try { Text2MapResultsLayer.clear(); } catch (e) { void e; } });
        await jump(page, { center: [C.lng, C.lat], zoom: 12.4, pitch: 0, bearing: 0 });
        await sleep(2500);
        await cap(page, '', '');
        await title(page, 'DigiPin\nKnow every cell.');
        await shot(page, '12-outro.png');

        console.log('STILLS DONE');
    } catch (e) {
        console.error('STILLS ERROR:', e);
        process.exitCode = 1;
    } finally {
        if (context) await context.close();
        if (browser) await browser.close();
        try { server.kill('SIGTERM'); } catch (e) { void e; }
    }
}

main();
