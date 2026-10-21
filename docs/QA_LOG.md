# QA log — integrated `dev` build

Short running log of QA / performance passes over the integrated `dev`
branch. Newest pass first. Each entry says how the pass was run, what was
checked, what was found, and what shipped as a result.

## 2026-10-21 — status strip: rows keep their DOM

- **Gap (CI, twice):** the resilience spec's click on the `heights` Retry button kept finding the button "detached from the DOM" for the whole 300 s window. The first fix (an idempotent `DataStatus.set()` for an unchanged row) was not enough: any other row arriving or clearing (`tiles`, `cellgaps:<id>` while a 3D city loads on the software renderer) rebuilt the whole strip, so the button was replaced between the locator resolving it and the click landing. A user mid-click would lose it the same way, and a screen-reader focus with it.
- **Fix:** `_render()` is incremental: a row whose text, kind and button label have not changed keeps its node; only changed rows are rebuilt, removed rows are dropped, order is kept. A failed Retry no longer re-renders either: the row stays and the button is handed back enabled.
- **Guards:** unit test that other keys arriving and clearing, a failed Retry, a text change and a dismiss each leave the untouched rows' nodes in place.

## 2026-10-21 — 3D draw cost on record

- **Why:** the design thread is adding to the 3D city (trees, edge lines, soft walls, legends, fly-through) and CI's software renderer cannot tell a 3 s frame from a 15 s one in any useful way. What can be measured on any machine is how much geometry each refresh hands deck.gl, and how long the CPU-only harvest + layer build holds the main thread.
- **Change:** `DeckBuildings.renderStats()` reports the last draw from either path (the dark deck.gl overlay, or the light theme's MapLibre "twin" source, which calls `noteDraw`): polygons, outer-ring vertices, selected count, height sources (overture / baked / estimate), refresh count and the last / longest refresh time; `resetRenderStats()` starts a window. The perf spec's six-city 3D sweep waits up to 45 s per city for a draw (first CI run: none had landed within the 1.5 s settle, so the gate fired on the empty record), logs one line per city (`3D draw delhi [twin]: … polygons, … vertices, longest … ms`) and gates each view at 60,000 polygons, 1,000,000 vertices and a 5 s longest refresh (real browser only; the stub has no deck.gl). The budgets are deliberately loose until a few CI runs give the baseline; the log lines are the point.
- **Guards:** unit tests for `polygonStats` and the zero-cost state; the perf spec under the stub still passes (zero geometry, no gate).

## 2026-10-21 — boot-time CDN libraries: georaster loads on first use

- **Gap:** app.html loaded four CDN libraries with the page. MapLibre, PMTiles and deck.gl are used at boot (or by the 3D view a share link can open into), but georaster, the COG/GeoTIFF parser, is only read by the realtime growth and heat overlays and the hydrology tool, all user actions. Every `defer` script delays the first usable frame on a slow link, and this one is a few hundred KB (the sandbox cannot reach unpkg, so the exact wire size and the first-load gain are not measured here; the CI runs download it).
- **Change:** `js/lazy-libs.js` keeps the pinned URL and integrity hash and injects the tag on first `LazyLibs.load('georaster')`; concurrent callers share one download, a failed load is forgotten so the next call retries, and a load that never fires rejects after 60 s. The three call sites await it (and fall back to a page-loaded `parseGeoraster` where LazyLibs is absent, for the unit-test contexts). sw.js still precaches the URL, so an installed app has it offline: the injected tag is answered from the service-worker cache.
- **Not changed:** deck.gl stays on the boot path. DeckBuildings decides synchronously whether deck.gl is available and falls back to MapLibre extrusions otherwise, and 3D is the feature Akkshay wants prominent, so taking it off boot needs an async hand-off in the 3D code (the design thread's area), not a loader.
- **Guards:** tests/lazy-libs.test.js (tag injected once with its hash, resolves to the global, error path retries, unknown library rejects, URL precached by sw.js and absent from app.html); the sw precache ↔ app.html test now also accepts a lazy library.

## 2026-10-21 — one script bundle for the published site

- **Correction to the entry two below:** those 13 s / 52 s figures came from the dev server, which did not compress. GitHub Pages gzips, so the honest baseline (serve.py `--gzip`, stub map, cold visit, `scripts/measure-first-load.js`) is: usable at 1.0 s unshaped, **5.6 s on fast 3G, 19.5 s on slow 3G** (138 requests, 2.4 MB raw / ~0.7 MB on the wire).
- **Change:** `scripts/build_bundle.py` runs in deploy.yml (next to the GeoParquet step) and concatenates the 129 local modules, in app.html order, into one `js/app.bundle.js` (2.14 MB raw, 575 kB gzipped); the published app.html loads that one file where the first module was and the published sw.js precaches it instead of the modules. Nothing changes in git: the source tree, the other threads and the browser suite keep the module-per-file layout. The script refuses to run if a local tag is not `defer`, a CDN `defer` tag sits between local ones, a module is listed twice or is missing; a `;` between files keeps an IIFE from being parsed as a call on the previous file's last expression, and a marker comment per module keeps error lines traceable.
- **After (same method):** usable at **3.9 s on fast 3G (from 5.6), 14.6 s on slow 3G (from 19.5)**; 22-29 requests instead of 138-157. The rest of the slow-3G time is bytes, not round trips: 0.7 MB over 400 kbps is 14 s. The next cut would be lazy-loading the dialogs that boot does not need (Intel, Agents, Lenses, DISHA: ~400 kB raw), which is a code change, not a build step.
- **Guards:** tests/build-bundle.test.js builds into a temporary copy and checks every module is present once and in order, the tags and precache are rewritten as intended, and Node parses the bundle; a new CI job `e2e-bundled` runs smoke, offline, workflows, a11y and perf in real Chromium on the bundled tree.

## 2026-10-21 — point-cloud viewer on a bad link

- **Read-through of the new LiDAR tool (js/point-cloud.js):** the viewer library is an ESM download from jsdelivr at first use and the sample is an 80 MB COPC on S3; neither had a timeout, so a stalled link left the panel waiting with no word, and a second click started a second load. Now the download times out at 30 s and a load at 180 s (both end in the existing error toast), the panel is aria-busy with its load controls disabled while a load runs, and `PointCloud.isBusy()` is exposed. Resilience spec: library download refused → error toast, controls enabled again, panel closes, no uncaught error.
- **Not measured here:** heap with a real cloud loaded and after Close. The sandbox has no CDN access and CI's software renderer cannot draw a 10-million-point cloud; this needs a GPU machine (a Remote Control run on Akkshay's device, or a GPU runner).

## 2026-10-21 — first load on a slow link: a splash that arrives with the page

- **Measured** (Playwright + CDP shaping, stub map, local server, no compression): the app is usable 1.1 s after navigation on an unshaped link, 13 s on fast 3G (1.6 Mbps / 150 ms) and 52 s on slow 3G (400 kbps / 400 ms). 160 requests, 2.9 MB uncompressed (GitHub Pages gzips, so the wire is ~0.8 MB; the 136 `<script>` tags and the round trips they cost dominate on a high-latency link).
- **Gap:** the loading splash was created by js/ui-polish.js, one of the last deferred scripts, so it appeared only once every script had arrived: body painted at 3 s and the splash at 13.5 s on fast 3G. For 10-50 s the user saw a still skeleton with nothing moving.
- **Fix:** the splash is static HTML at the top of `<body>` (ui-polish reuses it; hideSplash removes it on map load, after 8 s, or when the engine is missing). An inline timer changes the sub-line to "Still loading — the connection looks slow" at 6 s if the scripts have not run yet, and to a reload hint at 40 s. Resilience spec: fast-3G shaping, splash visible within 8 s of commit, slow note shown while scripts are in flight, splash gone once the app is up.
- **Not done (bigger than this thread):** fewer requests. A single concatenated bundle (or HTTP/2 push on the host) would take slow-3G first load from ~50 s to ~20 s; noted in tests/perf-budgets.test.js.

## 2026-10-21 — 3D heights on a flaky link; CI timing on the software renderer

- **Gap:** a baked height grid (1-5 MB per city) that timed out, hit a 5xx or lost the connection was silently replaced by footprint estimates, and the failed load was cached for the session so the real heights never came back. The index had the same one-shot cache. Now a non-404 failure is forgotten (the next pan or Retry refetches), one persistent DataStatus row (`heights`) says the city is drawing estimated heights, and it clears when every grid lands; `DeckBuildings.heightsCacheStats().failed` counts them. 404 stays silent: not baked is not a failure.
- **Stalled link (follow-up):** a grid or index request that hung without bytes or an error never resolved, so the city stayed on estimates with no row and no Retry. The index now times out at 10 s and a grid at 120 s (grids are up to 5 MB: ~25 s on slow 3G, and on CI the body read stalls behind software-GL frames, where 45 s tripped once), the reason is kept per grid (`failedReasons` in the stats: 'timeout' / 'network' / status), and Retry refetches every failed grid. The cell store already timed out parts at 15 s and the catalog at 8 s.
- **Tests:** unit tests for 5xx / dropped connection / 404 / timeout and the ensureHeights retry; a resilience spec case aborts every grid in the real browser with 3D on, checks the row and that the city still draws, then lets the grids through and clicks Retry.
- **CI timing (same day):** all of today's reds were the test harness, not the app. The layer-gaps test raced a boot-time profile load (a part fetched between the cache reset and the route was served from memory); the route now goes in first. The 3D-city journey (67 s alone), the share-link round trip (89 s) and the soak loop (572 s) all overran fixed windows when another 3D test shared the two-worker runner, where software-GL frames run 3-9 s. Windows are now 300 s for the journeys and, for the soak, the sum of its own per-visit waits; every profile rendered in every run.

## 2026-10-21 — slow or flaky link: what the user sees while cell data arrives

- **Gap 1:** the "Everything in this cell" card appeared only once its ~60 fetches landed; until then the slot was empty. Now a placeholder card ("Loading cell data for <code>…", aria-busy) shows at once and is replaced by the real card.
- **Gap 2:** a cell part that timed out, hit a 5xx or lost the connection was indistinguishable from "not published" (both null). The layer painted with silent holes, or toasted "No data published for this layer yet." for a network failure. The store now records the reason per part (`CellStore.failedParts()`, `CellStore.lastLoad(id)`), does not keep a degraded table, and the layer code posts a persistent DataStatus row ("<layer>: 3 of 9 data parts did not load — the map has gaps") with Retry, which refetches only the failed parts. The Layers row pulses (aria-busy) while parts load.
- **Tests:** unit tests for the failure bookkeeping and the 404-vs-failure split; resilience spec aborts every second part of a layer mid-session and checks the row, the partial paint, the Retry and a clean crash count.

## 2026-10-21 — soak: cold-city profile window

- Run 203 (4831f28) missed one of twelve profiles: Bengaluru's first visit took 94 s (second visit 29 s); every other city was under 60 s. Run 204/205 (1141daf) passed all 31 specs including soak.
- Cause: a city's first selection also pulls all its cell parts; on CI's SwiftShader the main thread is ~95% busy drawing 3D so fetch callbacks queue behind frames.
- Fix: the profile wait is 120 s on the first round, 60 s afterwards. The per-city timing line in the log stays so the next adjustment is from numbers.
- Follow-up (run 1032032): a warm second visit also missed at 60 s (Mumbai, 83 s) while the 3D frame cost was unchanged. Every profile wait is now 120 s: the soak's claim is that each profile renders, not that it renders within a number that depends on the runner's software rasteriser.

## 2026-10-21 — soak in CI: no GPU means 2-4 s per 3D frame

- **Found by:** the main-thread freeze budget added to tests/playwright/soak.spec.js. In CI (Chromium on SwiftShader) every frame with the 3D buildings layer on is a 2.5-3.9 s long task, back to back (420 s blocked out of 439 s). It also made a fixed-wait soak read the old city's centre, so twelve selections all hit Indore.
- **Meaning:** this is the software rasteriser, not something a user with a GPU sees; the stub run's longest task is ~350 ms. The soak now waits for the fly-to to land, selects each city's own centre, checks the panel shows that code, and only enforces the freeze budget when the WebGL renderer is not software.
- **Open:** measure the 3D frame cost on real hardware (DeckBuildings.heightsCacheStats reports ~110k cells for Indore); if it is more than a frame, the layer needs decimation at low zoom.

## 2026-10-21 — blocked map CDN left a blank page

- **Found by:** running the real app in a sandbox with unpkg.com unreachable (what a content blocker, captive portal or first offline visit does).
- **Symptom:** MapLibre never arrived, `MapModule.init` threw, the boot splash sat on screen and the only hint was a toast saying "the rest of the app still works".
- **Fix:** js/app.js detects the missing engine before map init, hides the splash, shows a persistent error notice with Retry and a centred card in the map box, and skips the map init (no misleading toast). Covered by a resilience spec case that aborts the MapLibre script in the real browser.

## 2026-10-21 — selectByCode silently did nothing with 3D buildings on

- **Found by:** the first real-browser run of tests/playwright/soak.spec.js. It passed, but the cache stats it printed showed zero cell-store parts loaded over twelve city selections.
- **Cause:** `MapModule.selectByCode` waited for the map's `idle` event after `flyTo`; with the deck.gl buildings overlay active the map never went idle, so the panel never opened. Search, keyboard navigation, hierarchy links and DISHA actions all go through this path.
- **Fix (681394a):** wait for `moveend`, then the next `idle` or 1.5 s, with a 5 s backstop. The soak now waits for the profile card after every selection and asserts parts were loaded, so a no-op cannot pass again.

## 2026-10-21 — soak test, crash guard, basemap fallback (reliability round 2)

**How:** new tests/playwright/soak.spec.js (two rounds over the six big cities with 3D on and a
cell selected each time; forced GC via CDP, heap + cache stats per round) plus CPU/allocation
sampling through the Chrome DevTools protocol in the no-network sandbox (STUB_MAP=1).

**Found:**
- Clicking a cell froze the page for 3–5 s. The profile card ranked each value against *every
  region of every dataset* (3.4 M cells), loading and sorting all of it on the main thread. Ranks
  are now computed against the cell's own city (`CellStore.loadView` on the region bbox), sorted
  as typed arrays in their own task. `UrbanInsights.areaInsights` yields between datasets.
- Memory grew without bound across cities: decoded cell-store parts were cached forever, view
  tables kept 24 concatenated copies (series re-aligned per cell), the deck.gl height grid merged
  every visited city, and insights kept every city's height grid. Heap hit 1.1 GB after two city
  rounds. Budgets now: parts ≤ 48 MB of source JSON (LRU), views ≤ 24 and ≤ 40 MB source, three
  height grids in the 3D layer, two in insights, rank columns for the current city only.
  After the fix the soak ends at ~250 MB after GC.
- `_concat` used `push(...cells)`; a 51k-cell region is near the argument-count limit. Loop now.
- A cell click still costs ~10 s of background CPU in the sandbox (insights over ~60 dataset
  views). Non-blocking now, but worth a per-city cache in the Intel engine.

**Shipped:** js/crash-guard.js (uncaught errors/rejections → persistent notice with Reload, ring
buffer `CrashGuard.recent()`), basemap fallback in js/map.js (inline plain style when the CARTO
style cannot load so the grid and data layers still draw; tile-failure notice), `CellStore.cacheStats()`,
`DeckBuildings.heightsCacheStats()`, `MapModule.basemapState()`; resilience cases for the crash
notice and the basemap fallback (the latter real-browser only); soak spec in CI.

## 2026-10-20 — first budget trip on dev (traffic refresh)

The static budgets in tests/perf-budgets.test.js tripped on the traffic + mobility refresh
(eddd390): `data/traffic/delhi/road_los.geojson` (9.7 MB), `data/traffic/bengaluru/road_los.geojson`
(7.4 MB) and `data/vectors/osm_roads_delhi.geojson` (7.2 MB) exceed the 6 MB per-file cap.
These road-level GeoJSONs load only when their layer is toggled for that city, so the cap for
`data/traffic/**` and `data/vectors/**` is now 10 MB; everything else keeps 6 MB. Delhi road LOS
is 0.3 MB under the new line — the next refresh should gzip it (the monthly cell series already
ship as `.json.gz`) or drop coordinate precision rather than raise the cap again.

Same run: tests/analysis.test.js built its Indore store from `regions[0]`, which became Ahmedabad
once catalog regions were sorted alphabetically. The test now picks the region by name/bbox and
merges sharded `.json.gz` tables.

## 2026-10-20 — reliability suite in CI (real browser)

**How.** `tests/playwright/{journeys,resilience,perf}.spec.js` now run in the
`e2e-smoke` CI job on every push to `dev` (real Chromium, real MapLibre and
tiles), plus `tests/perf-budgets.test.js` in vitest. Locally without CDN
access: `STUB_MAP=1 npx playwright test` (see `playwright.config.js`).

**First green run:** CI run #103 on 7416b97 — 23 browser specs pass in ~4.5
min. Boot: 116 own-origin requests, 1.6 MB, interactive in ~1.4 s on the
runner.

**Found by the suite.**

- `DataFetcher.exportToCSV` threw on a cell whose feature fetch had failed
  (no `categories`). Fixed; score rows are now written too.
- `data/heights/index.json` was fetched twice at boot (buildings-deck and
  city-overview). `DeckBuildings.heightIndex()` is now shared.
- My own `ci.yml` edit broke the workflow YAML for ~5 min (unquoted colon in
  a step name). Validate with a YAML loader before pushing workflow edits.

**Error states shipped.** `js/data-status.js`: persistent bottom-centre
notice for offline (incl. tab opened offline) and for the cell store being
unreachable, with Retry; covered by `resilience.spec.js`.

**Budgets (see `perf.spec.js` / `perf-budgets.test.js`).** Boot ≤ 4 MB /
200 requests / 15 s to interactive; any heights file ≤ 6 MB and fetched
once; largest response ≤ 6 MB; JS heap ≤ 450 MB after a 3D city sweep;
`data/cells` files ≤ 3 MB; `js/` ≤ 2 MB total; precache list ≤ 4 MB and
every entry exists on disk.

## 2026-10-20 — headless pass after the Aino-inspired feature drop

**How.** Static build served with `python3 -m http.server`; Chromium via
Playwright (`/opt/pw-browsers/chromium-1194`). CDNs are unreachable in the QA
box, so a tiny MapLibre/PMTiles stand-in is injected (records sources and
layers, fires `load`/`idle`/`moveend`, no WebGL). That means anything that
needs real tiles, `queryRenderedFeatures`, or deck.gl (3D buildings harvest,
heights per city, tile traffic) is **out of scope** for this harness and was
checked by code review only. Onboarding skipped via
`localStorage.digipin_onboarded = 'done'`.

**Checked.**

| Area | Result |
| --- | --- |
| Asset audit: every `<script>` in `app.html`, every `sw.js` precache entry | all present, no 404 |
| Boot network (desktop 1280px) | 117 requests, 1.6 MB, no 4xx/5xx, no body > 200 kB |
| 13 cities via the city select | switch OK, no console / page errors |
| All 60 layer rows + every LayersPanel analytics overlay toggled on/off | no page errors after the heatmap fix below |
| 3D + terrain + buildings + sun study together, then city switch | OK; Sun-hours / FAR buttons render output |
| Export dialog: CSV, GeoJSON, PNG snapshot, 3D model (.glb) tabs | render; GLB writer unit-tested (header, chunks, winding) |
| DISHA open-data search ("flood", "roads", "lst") | results render, "Add layer" ids resolve |
| Share link round trip (`URLState.capture` → `buildUrl` → reopen) | layers `3d`/`terrain`/`buildings`, `z`, `ll` restored |
| Cell deep link `?cell=34P-LL5-4L7` | cell selected, detail panel opens with content |
| Mobile 390px | no horizontal scroll, panels usable |
| JS heap after the overlay sweep | ~5 MB (stub map; real map will be higher) |

**Found and fixed.**

- **3D heatmap crash on toggle-off mid-load.** `HeatmapOverlay.clear()` nulls the
  shared `AbortController` while `show()` is still sampling; the next
  `_abortController.signal` read threw `Cannot read properties of null`.
  Fixed by capturing the controller per run; regression test in
  `tests/heatmap-overlay.test.js`.
- **Duplicate `data/cells/catalog.json` fetch at boot.** `AnalysesPanel`
  re-fetched the catalog only to read `generated`; it now asks
  `CellStore.generated()`.
- **Lint red on `dev`** after the time-slider merge (undeclared `TimeSlider`
  global) — fixed upstream in 9b041c9, confirmed green here.

**Found, not changed (by design or another thread's area).**

- Seven Digital-Twin OSM vector files (`vectors/osm_*_indore_pilot.geojson`
  other than roads/safety/transit) are not shipped; the Layers panel already
  probes them with `HEAD` and dims the row with "· no data".
- `data/heights/delhi.json` is 5.4 MB; it is loaded only when Delhi is in
  view and with `force-cache`. A per-city split or PMTiles is on the data
  thread's list.
- Sun-hours in the stub browser says "No daylight" because the stub has no
  real solar position; verified with the real `SunStudy.solarPosition` in a
  unit test (11.2 h daylight, Indore, 20 Oct).

**Not covered here.** Real-tile render performance, deck.gl buildings,
terrain DEM decode, service-worker update flow on a real deploy. These need
a browser with network access to the CDNs; next pass should run against the
Pages preview.
