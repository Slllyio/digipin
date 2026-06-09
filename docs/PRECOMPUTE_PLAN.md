# National Precompute Pipeline — Implementation Plan

**Goal:** turn the "160+ features for every 4×4 m cell in India" promise from
*capability on demand* (live per-click Overpass/Open-Meteo fetches, Indore-first)
into *precomputed coverage* — so any cell, anywhere in India, renders instantly
from static tiles with no per-click upstream calls.

This is the most ambitious item on the roadmap: a **multi-day data-engineering
effort**, not a single PR. It builds directly on the format decisions already in
[`DIGITAL_TWIN_ARCHITECTURE.md`](DIGITAL_TWIN_ARCHITECTURE.md) and the existing
`pipeline/` scripts.

## Why precompute

| Today (live per-click) | After precompute |
|---|---|
| Each cell click fires ~15 Overpass + weather/AQI/elevation calls | One range request into a static tile |
| Indore-tuned; other cities slower / rate-limited | Uniform national coverage |
| Overlays grid-sample 36+ live fetches per toggle | Read precomputed cell scores from a tileset |
| Upstream outages degrade UX | Self-hosted, $0 egress on R2 |

The overlays added recently (KDE, bivariate, accessibility) are the biggest
live-fetch consumers — they benefit most.

## Scope decision: don't precompute *everything*

Precomputing 160 features for every 4×4 m cell in India is astronomically large
(India ≈ 3.3 M km² → ~2×10¹¹ cells). Instead precompute at a **coarser analysis
grid** and keep the 4×4 m DigiPin code as the addressing scheme:

- **Analysis cell = ~100–250 m** (DigiPin level 8/9). That's ~10⁸ cells — large
  but tractable as tiled GeoParquet/PMTiles.
- Store the **~30 intelligence scores + key feature counts** per analysis cell,
  not all 160 raw features. Raw POIs stay as a vector tileset for on-demand
  detail.

## Staged delivery

### Phase 0 — Pilot tile (1 city, proves the pipeline) — ~1–2 days
1. Pick Indore. Generate the analysis grid (level-8 DigiPin cells over the city
   bbox). **✅ Done** — `pipeline/_lib/grid.py` (`cells_for_bbox`,
   `count_cells_for_bbox`) enumerates DIGIPIN cells exactly via integer index
   ranges. Sanity: the Indore pilot bbox is 2,209 cells at level 6 (~244 m) /
   33,489 at level 7 (~61 m) — confirming level 6–7 as the practical analysis
   resolution.
2. For each cell, run the scoring logic server-side against a **bulk Overpass
   extract** (one `.osm.pbf` for MP via Geofabrik, queried locally with
   `osmium`/DuckDB — no rate limits). **✅ Orchestrator done** —
   `pipeline/scores/score_grid.py` enumerates the grid, runs the parity-pinned
   `composite.py` scorers, and emits one flat (Parquet-ready) record per cell.
   The score math is fully ported and tested; the **only remaining piece is the
   feature counter** — the `osmium`/DuckDB adapter that turns a `.osm.pbf` into
   the per-cell `{categories, environment}` dict (a documented, stubbed seam,
   pending the extract download).
3. Write `indore_scores.parquet` (cell_code, 30 scores, feature counts).
4. Convert to PMTiles (`tippecanoe`) keyed by cell geometry.
5. Frontend: add a `PrecomputedScores` source that reads the PMTiles; overlays
   prefer it and fall back to live `fetchAllFeatures` when a cell is absent.

**Exit criterion:** Indore overlays render from the tile with zero live calls,
matching the live scores within rounding.

### Phase 1 — Tier-1 cities — ~2–3 days
- Generalise Phase 0 to a city list (the existing `city-selector` set).
- GitHub Actions matrix job (one city per shard) → upload Parquet → merge →
  PMTiles → push to **Cloudflare R2** (zero egress).
- Add a `coverage.json` manifest the frontend reads to know which regions are
  precomputed (drives the "precomputed vs live" UI badge).

### Phase 2 — National raster scores — ~3–5 days
- The environmental scores (heat/NDVI/elevation/flood) come from rasters, not
  OSM. Reuse the existing `pipeline/heat`, `pipeline/growth` extractors to
  produce **national COGs** on R2 (LST, NDVI, GHSL pop, SRTM, flood).
- Frontend already reads COGs via `georaster`; point it at the R2 COGs.
- This also **unlocks the Growth + Emerging-Hotspot features**, which are dormant
  today purely because `data/growth/*.tif` isn't hosted (see `GROWTH_FORECAST.md`).

### Phase 3 — Incremental refresh + analytics — ~2 days
- Monthly GitHub Actions cron re-runs changed regions (OSM diffs via
  `osmium derive-changes`); only re-tiles touched shards.
- Ship the `analytics/*.parquet` so DuckDB-WASM spatial SQL in the browser
  (already in the architecture doc) can answer "rank all cells by X" without a
  backend.

## Cost & hosting
Per `DIGITAL_TWIN_ARCHITECTURE.md`: Cloudflare R2, ~450 MB → **$0/month**
(10 GB free tier, zero egress). HTTP range requests serve PMTiles/COGs directly
to the browser; no server.

## Risks / decisions to make first
1. **Analysis-grid resolution** (100 m vs 250 m) — trades tile size vs detail.
2. **Score parity**: porting `js/*-score.js` to Python risks drift. Mitigation:
   golden-file tests comparing Python output to the JS output on a sample of
   cells (the score models are already pure functions, so this is mechanical).
3. **Overpass at scale**: must use bulk `.osm.pbf` extracts + local querying, not
   the public Overpass API (ToS + rate limits).
4. **Storage budget**: national level-8 Parquet may exceed the R2 free tier —
   measure on Phase 1 before committing to resolution.

## First concrete step
Phase 0, step 2 — port the score math to a Python module reused by the pipeline,
with golden-file parity tests against the JS. Everything else builds on that.

### ✅ Done — score porting (`pipeline/scores/`)
All three live score models are ported and pinned to the JS by golden-file
parity tests (`npm run golden:scores`, enforced fresh in CI):

- **Growth forecast** — `growth.py` (`js/growth-score.js`)
- **Urban heat island** — `heat.py` (`js/heat-score.js`)
- **Composite intelligence** (~24 scores) — `composite.py`
  (`DataFetcher.computeScores` in `js/data-fetcher.js`)

See [`pipeline/scores/README.md`](../pipeline/scores/README.md). The remaining
Phase 0 work is **step 1**: generate the Indore analysis grid and run these
scorers over a bulk OSM extract. `composite.py`'s input shape is exactly what a
local `osmium`/DuckDB feature-count query produces per cell.
