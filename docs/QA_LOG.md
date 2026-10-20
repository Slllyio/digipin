# QA log — integrated `dev` build

Short running log of QA / performance passes over the integrated `dev`
branch. Newest pass first. Each entry says how the pass was run, what was
checked, what was found, and what shipped as a result.

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
