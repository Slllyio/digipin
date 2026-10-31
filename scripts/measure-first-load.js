// First-load timing of app.html under network shaping, for before/after
// numbers on a change to what the page downloads (docs/QA_LOG.md keeps them).
//
//   python3 serve.py 8000 --quiet --gzip &      # gzip = production-like bytes
//   CHROMIUM_PATH=… node scripts/measure-first-load.js [http://localhost:8000/app.html]
//
// Uses the stub map (no CDN needed) and blocks the service worker so every
// run is a cold first visit. Prints, per profile: when the splash painted,
// when the app was usable (App defined, Layers button present), load event,
// request count and bytes. Chromium only (CDP shaping). CommonJS: package.json
// is "type": "commonjs".
const path = require('node:path');
const { chromium } = require('@playwright/test');

const URL = process.argv[2] || 'http://localhost:8000/app.html';
const PROFILES = {
  none: null,
  fast3g: { downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8, latency: 150 },
  slow3g: { downloadThroughput: 400e3 / 8, uploadThroughput: 400e3 / 8, latency: 400 },
};

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [name, cond] of Object.entries(PROFILES)) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('digipin_onboarded', 'done'); } catch { /* storage blocked */ } });
    await page.addInitScript({ path: path.join(__dirname, '..', 'tests', 'playwright', 'helpers', 'stub-map.js') });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    if (cond) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...cond });
    let bytes = 0; let reqs = 0;
    page.on('response', async (r) => { reqs++; try { bytes += (await r.body()).length; } catch { /* aborted */ } });
    const t0 = Date.now();
    await page.goto(URL, { waitUntil: 'commit', timeout: 300_000 });
    await page.waitForFunction(() => document.getElementById('app-splash'), null, { timeout: 300_000 });
    const tSplash = Date.now() - t0;
    await page.waitForFunction(() => typeof App !== 'undefined' && document.getElementById('btn-dt-layers'), null, { timeout: 300_000 });
    const tApp = Date.now() - t0;
    await page.waitForLoadState('load', { timeout: 300_000 }).catch(() => {});
    const tLoad = Date.now() - t0;
    console.log(`${name.padEnd(7)} splash ${tSplash} ms | usable ${tApp} ms | load ${tLoad} ms | ${reqs} req, ${(bytes / 1e6).toFixed(2)} MB`);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
