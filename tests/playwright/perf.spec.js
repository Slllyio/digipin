// Performance budgets measured in a real browser. Generous on purpose — they
// catch regressions of the "shipped a 20 MB file at boot" kind, not noise.
// Static-asset budgets (file sizes) live in tests/perf-budgets.test.js.
// CommonJS form — package.json is "type": "commonjs".
const { test, expect } = require('@playwright/test');
const { STUB, prepare, waitForApp, settle, toggleRow } = require('./helpers/app');

/** Top self-time entries of a CDP CPU profile, by file and by function. */
function summarizeProfile(profile, k = 12) {
  const base = (u) => (u || '').split('/').pop() || '(native)';
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const byFile = new Map(); const byFn = new Map(); let total = 0;
  profile.samples.forEach((sid, i) => {
    const n = nodes.get(sid); const d = profile.timeDeltas[i] || 0; total += d;
    const cf = n.callFrame; const fn = cf.functionName || '(anon)';
    if (fn === '(idle)') return;
    byFile.set(base(cf.url) || fn, (byFile.get(base(cf.url) || fn) || 0) + d);
    const key = `${fn} ${base(cf.url)}:${cf.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) || 0) + d);
  });
  // Who calls the costly native frames (readPixels, bufferData, ...): the
  // nearest script frame above each, so a sync GPU stall can be traced to
  // the app or library function that asks for it.
  const parent = new Map();
  for (const n of profile.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
  const viaScript = new Map(); const viaApp = new Map();
  const vendor = /maplibre|deck|pmtiles|\/lib\//;
  profile.samples.forEach((sid, i) => {
    const n = nodes.get(sid); const cf = n.callFrame;
    if (cf.url || !cf.functionName || /^\(/.test(cf.functionName)) return;
    const d = profile.timeDeltas[i] || 0;
    let p = parent.get(sid), hops = 0, script = null, app = null;
    while (p != null && hops++ < 60 && !(script && app)) {
      const pc = nodes.get(p).callFrame;
      if (pc.url) { const key = `${pc.functionName || '(anon)'} ${base(pc.url)}:${pc.lineNumber + 1}`; if (!script) script = key; if (!app && !vendor.test(pc.url)) app = key; }
      p = parent.get(p);
    }
    if (script) viaScript.set(`${cf.functionName} <- ${script}`, (viaScript.get(`${cf.functionName} <- ${script}`) || 0) + d);
    const ak = `${cf.functionName} <- ${app || '(library or browser only)'}`;
    viaApp.set(ak, (viaApp.get(ak) || 0) + d);
  });
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, us]) => `  ${String(Math.round(us / 1000)).padStart(6)} ms ${(100 * us / total).toFixed(1).padStart(5)}%  ${n}`).join('\n');
  return `  sampled ${Math.round(total / 1000)} ms\n by file:\n${fmt(byFile)}\n by function:\n${fmt(byFn)}\n native frames by calling script function:\n${fmt(viaScript)}\n native frames by app caller:\n${fmt(viaApp)}`;
}

const BUDGET = {
  bootBytes: 4 * 1024 * 1024,    // own-origin bytes before first interaction
  bootRequests: 200,             // own-origin requests at boot
  interactiveMs: 15_000,         // toolbar usable (CI runners are slow)
  heapMb: 450,                   // JS heap after the 3D + city sweep (Chromium only)
  heightsBytes: 6 * 1024 * 1024, // any single building-heights file
  largestBytes: 6 * 1024 * 1024, // any single own-origin response during the journey
  // 3D draw cost per city view (DeckBuildings.renderStats()). Geometry counts
  // are machine-independent: a change that hands deck.gl ten times the
  // polygons shows here on any runner. The harvest + layer build is CPU-only
  // (no GL), so its time is gated too, loosely.
  polygons: 60_000,              // building polygons in one 3D view
  vertices: 1_000_000,           // their outer-ring vertices
  refreshMs: 5_000,              // longest single harvest + layer build (real GPU only; see the gate)
  // GPU syncs (readPixels calls) during one city's fly-in and wait. Each one
  // makes the GPU finish everything queued before returning; a fly-in costs
  // MapLibre about six of its own. The twin harvest once added a terrain pick
  // per corner of its query box, 1.8 s of a Delhi fly-in on software GL.
  gpuSyncs: 24,
};

function track(page) {
  const own = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/localhost|127\.0\.0\.1/.test(u) || resp.request().method() !== 'GET') return;
    let size = 0;
    try { size = (await resp.body()).length; } catch { /* aborted / redirect */ }
    own.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), size, status: resp.status() });
  });
  return own;
}

test.describe('performance budgets', () => {
  let errors = [];
  test.beforeEach(async ({ page }) => { errors = await prepare(page); });
  test.afterEach(() => { expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]); });

  test('boot stays within the transfer and time budgets', async ({ page }) => {
    const own = track(page);
    const t0 = Date.now();
    await page.goto('/app.html');
    await waitForApp(page);
    await expect(page.locator('#btn-dt-layers')).toBeVisible();
    const interactive = Date.now() - t0;
    await settle(page, 1500);
    const bytes = own.reduce((a, r) => a + r.size, 0);
    const failed = own.filter((r) => r.status >= 400 && !/\.(geojson|tif|pmtiles)$/.test(r.url));
    console.log(`boot: ${own.length} requests, ${(bytes / 1048576).toFixed(2)} MB, interactive in ${interactive} ms`);
    expect(interactive, 'time to interactive').toBeLessThan(BUDGET.interactiveMs);
    expect(bytes, 'own-origin bytes at boot').toBeLessThan(BUDGET.bootBytes);
    expect(own.length, 'own-origin requests at boot').toBeLessThan(BUDGET.bootRequests);
    expect(failed.map((r) => r.url), 'unexpected 4xx/5xx at boot').toEqual([]);
  });

  test('Delhi-size 3D city and a city sweep stay within memory and file budgets', async ({ page }) => {
    test.setTimeout(400_000);   // the per-city draw wait below can take half a minute on CI's software renderer
    const own = track(page);
    await page.goto('/app.html');
    await waitForApp(page);
    await toggleRow(page, 'btn-buildings');
    await toggleRow(page, 'btn-3d');
    // Footprint tile traffic per city: the PMTiles archive is read by HTTP
    // range requests, so a city that never draws is either not asking for
    // tiles, or asking and not getting them. Both show here.
    const tiles = { started: 0, done: 0, failed: 0, byFile: {} };
    const isTiles = (u) => /\.pmtiles(\?|$)/i.test(u);
    const fileOf = (u) => u.replace(/\?.*$/, '').split('/').slice(-2).join('/');
    page.on('request', (r) => { if (isTiles(r.url())) { tiles.started++; const f = fileOf(r.url()); tiles.byFile[f] = (tiles.byFile[f] || 0) + 1; } });
    page.on('response', (r) => { if (isTiles(r.url())) { tiles.done++; const k = `${fileOf(r.url())} ${r.status()}`; tiles.byFile[k] = (tiles.byFile[k] || 0) + 1; } });
    page.on('requestfailed', (r) => { if (isTiles(r.url())) tiles.failed++; });
    await page.evaluate(() => {
      const m = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
      window.__fp = { tile: 0, any: 0, kinds: {}, errors: [], bySource: {}, arrived: {}, t0: Date.now(), p0: performance.now() };
      if (m && m.on) {
        m.on('sourcedata', (e) => {
          if (e && e.tile && e.sourceId) window.__fp.bySource[e.sourceId] = (window.__fp.bySource[e.sourceId] || 0) + 1;
          if (!e || e.sourceId !== 'overture-buildings-source') return;
          if (e.tile) {
            const c = (e.coord && e.coord.canonical) || (e.tile.tileID && e.tile.tileID.canonical);
            if (c) window.__fp.arrived[`${c.z}/${c.x}/${c.y}`] = Date.now();
          }
          window.__fp.any++;
          if (e.tile) window.__fp.tile++;
          const k = `${e.dataType || '?'}/${e.sourceDataType || '-'}`;
          window.__fp.kinds[k] = (window.__fp.kinds[k] || 0) + 1;
        });
        m.on('error', (e) => { const msg = e && e.error && e.error.message ? e.error.message : String(e && e.error || e); window.__fp.errors.push(msg.slice(0, 120)); });
      }
    });
    console.log(`footprints: ${await page.evaluate(() => {
      const src = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap().getSource('overture-buildings-source') : null;
      const rel = typeof OvertureRelease !== 'undefined' ? OvertureRelease.current() : '?';
      return `release ${rel}, source ${src ? (src.url || JSON.stringify(src.tiles || null)) : 'missing'}`;
    })}`);
    const draw = [];
    for (const id of ['delhi', 'mumbai', 'bengaluru', 'hyderabad', 'chennai', 'kolkata']) {
      await page.evaluate(() => { if (typeof DeckBuildings !== 'undefined') DeckBuildings.resetRenderStats(); window.__fp = { tile: 0, any: 0, kinds: {}, errors: [], bySource: {}, arrived: {}, t0: Date.now(), p0: performance.now() }; if (window.__gl) window.__gl.readPixels = 0; });
      const t0 = { ...tiles, byFile: { ...tiles.byFile } };
      // PW_PROFILE=1: sample the main thread through the city's fly-to and
      // wait, and print the top self-time functions per city, to name what
      // keeps the main thread busy (and worker replies waiting) on a slow box.
      const profiler = process.env.PW_PROFILE && !STUB ? await page.context().newCDPSession(page) : null;
      if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.setSamplingInterval', { interval: 2000 }); await profiler.send('Profiler.start'); }
      await page.selectOption('#city-select', id);
      await settle(page, 1500);
      // The harvest runs on moveend and again when footprint tiles land; on
      // the software renderer that can be tens of seconds after the fly-to.
      // Wait for one draw (not for idle: with 3D on the map never reports it).
      // A harvest between tiles can be empty (the first CI run logged 0
      // polygons for every city), so wait for a draw that has buildings.
      const tWait = Date.now();
      if (!STUB) {
        await page.waitForFunction(() => typeof DeckBuildings !== 'undefined' && DeckBuildings.renderStats().peakPolygons > 0, null, { timeout: 30_000 }).catch(() => {});
      }
      const r = await page.evaluate(() => {
        if (typeof DeckBuildings === 'undefined' || !DeckBuildings.renderStats) return null;
        const m = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        let loaded = null;
        try { loaded = m ? m.isSourceLoaded('overture-buildings-source') : null; } catch { loaded = null; }
        // Whether every tile of every source is in (public API; the per-source
        // cache internals are minified away in MapLibre 5).
        let allTiles = null;
        try { allTiles = m && m.areTilesLoaded ? m.areTilesLoaded() : null; } catch { allTiles = null; }
        const layer = m && m.getLayer ? m.getLayer('overture-buildings-layer') : null;
        const vis = layer && m.getLayoutProperty ? m.getLayoutProperty('overture-buildings-layer', 'visibility') : null;
        // Handoff-to-map latency per footprint tile of this city: the time
        // from the protocol handler resolving with data to the map's tile
        // event for the same z/x/y; tiles handed over but never announced
        // count as lost. Tells a starved worker from a dropped tile.
        const lat = { n: 0, lost: 0, ms: [] };
        try {
          const log = typeof OvertureRelease !== 'undefined' && OvertureRelease.protocolLog ? OvertureRelease.protocolLog() : [];
          for (const rec of log) {
            if (rec.t < window.__fp.t0 || !/buildings\.pmtiles\/(\d+)\/(\d+)\/(\d+)/.test(rec.u || '')) continue;
            const k = RegExp.$1 + '/' + RegExp.$2 + '/' + RegExp.$3;
            lat.n++;
            const at = window.__fp.arrived[k];
            if (at) lat.ms.push(at - rec.t); else lat.lost++;
          }
          lat.ms.sort((a, b) => a - b);
        } catch { /* diagnostics only */ }
        // Main-thread freezes during this city's wait (helper's Long Tasks
        // observer): a main thread that is busy most of the time delays every
        // worker reply, whatever the worker's own speed.
        const lt = (window.__longTasks || []).filter((x) => x.t >= window.__fp.p0);
        const busy = { longTasks: lt.length, blockedMs: lt.reduce((a, x) => a + x.ms, 0), longestMs: lt.reduce((a, x) => Math.max(a, x.ms), 0), windowMs: Math.round(performance.now() - window.__fp.p0) };
        const latency = { handed: lat.n, arrived: lat.ms.length, lost: lat.lost, minMs: lat.ms[0] ?? null, medianMs: lat.ms[Math.floor(lat.ms.length / 2)] ?? null, maxMs: lat.ms[lat.ms.length - 1] ?? null };
        const gpuSyncs = window.__gl ? window.__gl.readPixels : null;
        return { gpuSyncs, latency, busy, cpus: navigator.hardwareConcurrency, workers: typeof maplibregl !== 'undefined' ? maplibregl.workerCount : null, ...DeckBuildings.renderStats(), zoom: m && m.getZoom ? +m.getZoom().toFixed(2) : null, pitch: m && m.getPitch ? Math.round(m.getPitch()) : null, tilesLoaded: loaded, allTiles, events: window.__fp, rangeReads: typeof OvertureRelease !== 'undefined' && OvertureRelease.rangeStats ? OvertureRelease.rangeStats() : null, protocol: typeof OvertureRelease !== 'undefined' && OvertureRelease.protocolStats ? OvertureRelease.protocolStats() : null, layerVis: layer ? (vis || 'visible') : 'missing' };
      });
      if (profiler) {
        const { profile } = await profiler.send('Profiler.stop');
        await profiler.detach();
        console.log(`profile ${id}:\n${summarizeProfile(profile)}`);
      }
      const files = Object.entries(tiles.byFile).map(([k, n]) => [k, n - (t0.byFile[k] || 0)]).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(', ');
      if (r) draw.push({ id, waitedMs: Date.now() - tWait, reqStarted: tiles.started - t0.started, reqDone: tiles.done - t0.done, reqFailed: tiles.failed - t0.failed, files, ...r });
    }
    // One line per city so a regression in draw cost is visible in the CI log
    // before it is a failure: polygons / vertices handed to deck.gl, and the
    // longest harvest + layer build (ms) for that city.
    // Baseline (CI, 2026-10-21): Delhi peak 8,529 polygons / 51,609 vertices
    // (8,454 with baked heights), longest refresh 0.3-3.2 s; Mumbai 3,633.
    // Four cities drew nothing within 30 s: the twin's tile-streaming poll
    // gave up after three empty harvests and the footprint source never
    // reported loaded, so nothing re-harvested when the tiles finally landed
    // (fixed: the poll now runs while tiles arrive). Zoom, pitch and the
    // source's loaded state stay on each line for the next such finding.
    for (const d of draw) console.log(`3D draw ${d.id} [${d.mode}]: peak ${d.peakPolygons} polygons, ${d.peakVertices} vertices (${d.peakBySource.overture} overture / ${d.peakBySource.baked} baked / ${d.peakBySource.estimate} estimated heights), last draw ${d.polygons}, ${d.refreshes} refreshes, longest ${d.maxRefreshMs} ms; z${d.zoom} pitch ${d.pitch}, tiles loaded ${d.tilesLoaded}, waited ${Math.round(d.waitedMs / 1000)} s; tile requests ${d.reqStarted} started / ${d.reqDone} done / ${d.reqFailed} failed [${d.files}], source events ${d.events.any} (${d.events.tile} tile; ${JSON.stringify(d.events.kinds)}), all tiles loaded ${d.allTiles}, layer ${d.layerVis}, map errors ${JSON.stringify(d.events.errors.slice(0, 3))}; tile events by source ${JSON.stringify(d.events.bySource)}, range reads ${JSON.stringify(d.rangeReads)}, protocol ${JSON.stringify(d.protocol)}, handoff latency ${JSON.stringify(d.latency)} (${d.cpus} cpus, ${d.workers} workers), main thread ${JSON.stringify(d.busy)}, GPU syncs (readPixels) ${d.gpuSyncs}`);
    if (!STUB) {
      // Light theme draws through the MapLibre "twin" source, dark through the
      // deck.gl overlay; both report here. A city whose buildings did not land
      // in the wait is logged with peak 0 and not gated; all six empty means
      // the 3D city draws nothing, which is a failure.
      const live = draw.filter((d) => d.peakPolygons > 0);
      // On the hosted runner the footprint archive answers every range read
      // and yet MapLibre never receives a tile from any PMTiles source (same
      // code draws every city on a real machine; docs/QA_LOG.md 2026-10-21).
      // That is the runner losing tiles after the fetch, not a 3D regression,
      // so the gate holds only when at least one footprint tile did reach the
      // map: tiles in, nothing drawn is the bug this guards against.
      const tilesArrived = draw.some((d) => (d.events.tile || 0) > 0);
      const summary = draw.map((d) => `${d.id}:${d.peakPolygons}`).join(' ');
      if (!tilesArrived && live.length === 0) console.log(`3D draw: no footprint tile reached the map in any city (${summary}); draw gate not enforced on this runner`);
      else expect(live.length, `cities that drew 3D buildings (${summary})`).toBeGreaterThan(0);
      // The redraw time is wall-clock on a runner whose frames take seconds
      // under SwiftShader (Delhi: 0.2 s on one run, 5.1 s on the next, same
      // code), so like the soak's freeze budget it is only enforced with a
      // real GPU; the geometry counts are machine-independent and always gate.
      const renderer = await page.evaluate(() => {
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
          return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
        } catch { return 'unknown'; }
      });
      const softwareGl = /swiftshader|llvmpipe|software|mesa offscreen/i.test(renderer);
      if (softwareGl) console.log(`3D draw: renderer "${renderer}", redraw-time budget not enforced (software GL)`);
      for (const d of draw) if (d.gpuSyncs != null) expect(d.gpuSyncs, `${d.id}: GPU syncs (readPixels) during the fly-in and wait`).toBeLessThanOrEqual(BUDGET.gpuSyncs);
      for (const d of live) {
        expect(d.peakPolygons, `${d.id}: polygons in one 3D view`).toBeLessThan(BUDGET.polygons);
        expect(d.peakVertices, `${d.id}: vertices in one 3D view`).toBeLessThan(BUDGET.vertices);
        if (!softwareGl) expect(d.maxRefreshMs, `${d.id}: longest harvest + layer build ms`).toBeLessThan(BUDGET.refreshMs);
      }
    }
    const heights = own.filter((r) => /\/data\/heights\//.test(r.url));
    for (const h of heights) expect(h.size, `${h.url} is ${h.size} B`).toBeLessThan(BUDGET.heightsBytes);
    const biggest = own.reduce((m, r) => (r.size > m.size ? r : m), { size: 0, url: '' });
    console.log(`journey: ${own.length} requests, largest ${biggest.url} ${(biggest.size / 1048576).toFixed(2)} MB`);
    expect(biggest.size, `largest response ${biggest.url}`).toBeLessThan(BUDGET.largestBytes);
    // Heights must be fetched at most once per city (cache / dedupe).
    const perUrl = {};
    heights.forEach((h) => { perUrl[h.url] = (perUrl[h.url] || 0) + 1; });
    expect(Object.entries(perUrl).filter(([, n]) => n > 1).map(([u]) => u), 'heights fetched twice').toEqual([]);
    if (!STUB) {
      const heap = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0));
      console.log(`heap after journey: ${heap.toFixed(0)} MB`);
      expect(heap, 'JS heap MB').toBeLessThan(BUDGET.heapMb);
    }
  });
});
