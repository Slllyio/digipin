/**
 * promo-clips.mjs — record one live MOTION clip per narration scene.
 *
 * Reads extras/out/narration/manifest.json (scene id, theme, motion, dur) and
 * records a clip whose final `dur` seconds are pure motion (so build-narrated.py
 * can trim the app-load tail off the front and line each clip up with its
 * narration). Motion (orbit / slow zoom / metric swaps / Text2Map reveal) is
 * what makes the 3D + interactivity read on screen. Captions are burned in.
 *
 * Out: extras/out/clips/<id>.webm
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, renameSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(__dirname, 'out');
const CLIPS = join(OUT, 'clips');
const PORT = 8099;
const BASE = `http://localhost:${PORT}/app.html`;
const C = { lng: 75.8577, lat: 22.7196 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPS = {
    '01-intro': ['', 'DigiPin · Urban Intelligence'],
    '02-grid': ['The DIGIPIN grid', 'Every point → a short, precise, shareable code'],
    '03-livability': ['Livability score', '0–100 per cell · green = safer, greener, healthier, quieter'],
    '04-walkability': ['Walkability', 'Swap any of 20 metrics — the city re-colours instantly'],
    '05-commercial': ['Commercial activity', 'Busy retail & office cores vs quiet residential gaps'],
    '05b-floodrisk': ['Flood risk', 'Low-lying, drainage-poor cells most likely to inundate'],
    '06-buildings3d': ['3D buildings', 'Real footprints, extruded to their true heights'],
    '06b-heatmap3d': ['3D score heat-map', 'Taller & greener = higher-scoring cells'],
    '06c-panel': ['Per-cell intelligence', 'Live weather · air quality (AQI) · 160+ features · scores'],
    '07-themes': ['Two themes', 'Paper-light Aino ↔ dark control-room'],
    '08-darkscores': ['Scores, in the dark', 'The palette glows on the deep canvas'],
    '09-text2map': ['Ask in plain English', '“family-friendly · good schools · low flood risk” → ranked on the map'],
    '10-outro': ['', 'DigiPin — know every cell'],
};

async function waitForMap(page) {
    await page.waitForFunction(() => (
        typeof MapModule !== 'undefined' && MapModule.getMap
        && MapModule.getMap() && MapModule.getMap().loaded()
    ), { timeout: 45000 });
    await sleep(4000);
}

async function injectOverlay(page) {
    await page.evaluate(() => {
        document.getElementById('promo-cap')?.remove();
        const w = document.createElement('div');
        w.id = 'promo-cap';
        w.innerHTML = '<div id="pt"></div><div id="pl"><div id="ph"></div><div id="ps"></div></div>'
            + '<div id="pb">DigiPin · Urban Intelligence</div>';
        const css = document.createElement('style');
        css.textContent = `
          #promo-cap{position:fixed;inset:0;z-index:99999;pointer-events:none;font-family:Inter,system-ui,sans-serif}
          #pt{position:absolute;top:44%;left:50%;transform:translate(-50%,-50%);text-align:center;
            font-size:78px;font-weight:800;letter-spacing:-1.5px;color:#fff;text-shadow:0 6px 44px rgba(0,0,0,.65);
            max-width:84%;white-space:pre-line;line-height:1.03}
          #pl{position:absolute;left:64px;bottom:74px;max-width:64%}
          #ph{font-size:44px;font-weight:800;color:#fff;letter-spacing:-.5px;text-shadow:0 3px 22px rgba(0,0,0,.75);margin-bottom:10px}
          #ps{font-size:25px;font-weight:500;color:#eef2f6;line-height:1.45;text-shadow:0 2px 18px rgba(0,0,0,.85)}
          #pb{position:absolute;top:32px;left:64px;font-size:19px;font-weight:700;letter-spacing:.5px;color:#fff;
            background:rgba(221,107,74,.95);padding:10px 20px;border-radius:999px;box-shadow:0 8px 30px rgba(0,0,0,.4)}`;
        document.head.appendChild(css);
        document.body.appendChild(w);
        window.__set = (t, h, s) => {
            document.getElementById('pt').textContent = t || '';
            document.getElementById('ph').textContent = h || '';
            document.getElementById('ps').textContent = s || '';
        };
    });
}

async function paintScores(page, key) {
    return page.evaluate(async (key) => {
        const m = MapModule.getMap(); const bb = m.getBounds();
        const cells = await PrecomputedScores.lookupViewport(
            { south: bb.getSouth(), west: bb.getWest(), north: bb.getNorth(), east: bb.getEast() });
        const feats = [];
        for (const c of (cells || [])) {
            const b = c.bounds; if (!b) continue;
            const s = c.scores ? c.scores[key] : null;
            const v = Number(s && typeof s === 'object' ? s.value : s);
            if (!isFinite(v)) continue;
            feats.push({ type: 'Feature', properties: { v }, geometry: { type: 'Polygon', coordinates: [[
                [b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] } });
        }
        const SRC = 'pc-src', F = 'pc-fill', L = 'pc-line';
        for (const id of [L, F]) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(SRC)) m.removeSource(SRC);
        m.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
        m.addLayer({ id: F, type: 'fill', source: SRC, paint: { 'fill-color': ['step', ['get', 'v'],
            '#d7301f', 30, '#ef6548', 45, '#fdae61', 60, '#a6d96a', 75, '#1a9850'], 'fill-opacity': 0.62 } });
        m.addLayer({ id: L, type: 'line', source: SRC, paint: { 'line-color': 'rgba(255,255,255,0.16)', 'line-width': 0.6 } });
        return feats.length;
    }, key);
}

async function buildingsOn(page) {
    await page.evaluate(() => { if (!OvertureBuildings.isActive()) OvertureBuildings.toggle(MapModule.getMap()); });
}

// Set up a scene at its start state, then drive `dur` seconds of motion last.
async function drive(page, scene) {
    const m = scene.motion;
    const dur = scene.dur;
    const ms = Math.round(dur * 1000);
    const ease = (o) => page.evaluate((o) => MapModule.getMap().easeTo(o), o);
    const jump = (o) => page.evaluate((o) => MapModule.getMap().jumpTo(o), o);

    if (m === 'zoomin') {
        await jump({ center: [C.lng, C.lat], zoom: 11.6, pitch: 0, bearing: 0 });
        await sleep(2500);
        await ease({ zoom: 13.2, duration: ms });
    } else if (m === 'pan') {
        await jump({ center: [C.lng, C.lat], zoom: 13.4, pitch: 0, bearing: 0 });
        await sleep(2500);
        await ease({ center: [C.lng + 0.03, C.lat + 0.012], zoom: 13.7, duration: ms });
    } else if (m.startsWith('scores:')) {
        const key = m.split(':')[1];
        await jump({ center: [C.lng, C.lat], zoom: 13.9, pitch: 0, bearing: 0 });
        await sleep(1500);
        const n = await paintScores(page, key);
        console.log(`   ${scene.id} cells=${n}`);
        await sleep(1500);
        await ease({ zoom: 14.3, center: [C.lng + 0.012, C.lat], duration: ms });
    } else if (m === 'orbit') {
        await jump({ center: [C.lng, C.lat], zoom: 15.9, pitch: 0, bearing: -38 });
        await sleep(1500);
        await buildingsOn(page);
        await sleep(4000); // let extrusions stream in before the reveal
        await ease({ pitch: 66, bearing: 40, zoom: 16.2, duration: ms });
    } else if (m === 'text2map') {
        await jump({ center: [C.lng, C.lat], zoom: 12.9, pitch: 0, bearing: 0 });
        await sleep(1500);
        const n = await page.evaluate(async () => {
            const mp = MapModule.getMap(); const bb = mp.getBounds();
            const out = await Text2Map.run('family-friendly area near good schools with low flood risk',
                { south: bb.getSouth(), west: bb.getWest(), north: bb.getNorth(), east: bb.getEast() }, () => {});
            return (out && out.results && window.Text2MapResultsLayer) ? Text2MapResultsLayer.show(out.results) : -1;
        });
        console.log(`   ${scene.id} t2m cells=${n}`);
        await sleep(1500);
        await ease({ zoom: 13.4, duration: ms }); // gentle push-in on the highlighted cells
    } else if (m === 'heatmap') {
        await jump({ center: [C.lng, C.lat], zoom: 13.4, pitch: 52, bearing: 18 });
        await sleep(1200);
        await page.evaluate(() => { try { HeatmapOverlay.show('livability'); } catch (e) { void e; } });
        await sleep(3500); // columns build
        await ease({ bearing: -18, pitch: 58, duration: ms });
    } else if (m === 'panel') {
        await jump({ center: [C.lng, C.lat], zoom: 15 });
        await sleep(800);
        await page.evaluate((o) => { try { MapModule.selectByCode(DigiPin.encode(o.lat, o.lng)); } catch (e) { void e; } }, C);
        await sleep(11000); // let live weather/AQI/feature counts populate the panel
        await ease({ zoom: 15.4, duration: ms });
    } else if (m === 'zoomout') {
        await jump({ center: [C.lng, C.lat], zoom: 13.6, pitch: 0, bearing: 0 });
        await sleep(2000);
        await ease({ zoom: 11.8, duration: ms });
    }
    // The motion easeTo is the final action; wait it out so it fills the clip tail.
    await sleep(ms + 400);
}

async function recordScene(browser, scene) {
    const ctx = await browser.newContext({
        viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true,
        recordVideo: { dir: CLIPS, size: { width: 1920, height: 1080 } },
    });
    await ctx.addInitScript((theme) => {
        try { localStorage.setItem('digipin_onboarded', 'done'); localStorage.setItem('digipin_theme', theme); } catch (e) { void e; }
    }, scene.theme);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('console', (mm) => { if (mm.type() === 'error') { /* ignore noisy CDN errors */ } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitForMap(page);
    await injectOverlay(page);
    const [t, s] = CAPS[scene.id] || ['', ''];
    const h = (t && t.length) ? t : '';
    await page.evaluate(([tt, hh, ss]) => window.__set(tt, hh, ss),
        h ? ['', h, s] : [s, '', '']); // no title text → use big centred title (intro/outro)
    await drive(page, scene);
    const vp = await page.video().path();
    await ctx.close();
    renameSync(vp, join(CLIPS, `${scene.id}.webm`));
    console.log(`✓ ${scene.id} (${scene.dur}s)`);
}

async function main() {
    const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
    if (!only) rmSync(CLIPS, { recursive: true, force: true }); // ONLY re-shoots in place
    mkdirSync(CLIPS, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(OUT, 'narration', 'manifest.json'), 'utf-8'));
    const server = spawn('python3', ['serve.py', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
    await sleep(2500);
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
            '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    });
    try {
        for (const scene of manifest) {
            if (only && !only.includes(scene.id)) continue;
            await recordScene(browser, scene);
        }
        console.log('CLIPS DONE');
    } catch (e) {
        console.error('CLIPS ERROR:', e);
        process.exitCode = 1;
    } finally {
        await browser.close();
        try { server.kill('SIGTERM'); } catch (e) { void e; }
    }
    // leftover stray webms (if any) — note names
    console.log('files:', readdirSync(CLIPS).join(', '));
}

main();
