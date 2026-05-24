# Urban Growth Forecast — Design Spec

| Field | Value |
|---|---|
| **Spec date** | 2026-05-24 |
| **Status** | Design approved — has prerequisites (see §11) before implementation begins |
| **Audience** | Future maintainers + spec reviewer subagent |
| **Author** | Brainstormed via `/superpowers:brainstorming` skill |
| **Feature working name** | DigiPin Growth Pulse (panel: "Growth Forecast", toolbar: "Growth") |
| **Prerequisites** | 1) GEE service account verified (§11.1) · 2) Flood-widget visual pattern landed on `main` OR alternative styling approved (§11.2) |

## 1. Summary

A new layer in the DigiPin portal that surfaces *where Indian cities are growing*, framed for civic and urban-planner users. For any clicked DigiPin cell, the panel shows three forward-looking scores — **Nowcast** (last 12 months), **1–2 year**, **5-year** — each a composite of three growth dimensions (built-up expansion, densification, capital flow). A toolbar toggle renders the active horizon's score as a heatmap across the visible map.

The feature is **honest about its limitations**: the 5-year layer is linear-trend extrapolation with a per-cell confidence band that widens for noisy data, not a real forecasting model. Disclosure is built into the UI, not buried in a docstring.

## 2. Goals & non-goals

### Goals (v1)

- Surface a per-cell composite growth score across three time horizons
- Reuse the existing flood-widget visual language (sparkline-style, dark glass-morphism)
- Power a new map heatmap overlay alongside the existing toolbar layers
- Inject growth context into DISHA's LLM prompt the way `result.realtime.flood` already is
- Honest disclosure of uncertainty in every surface (panel, map, LLM context)
- Ship in a single PR (v1 scope is "all three layers at lower fidelity")

### Non-goals (deferred to follow-ups)

- Survey-grade hydraulic / land-use modelling for the 5-year layer
- Multi-state RERA coverage (v1 = Madhya Pradesh only)
- Master-plan zoning data integration
- Transaction-history-based price calibration
- CA-MARKOV cellular-automata predictive models
- Per-user persistence of horizon toggle / scenarios
- Real-time growth refresh — pipeline runs quarterly, not minute-by-minute

## 3. Brainstorm decisions (with rationale)

| Decision | Rationale |
|---|---|
| Primary user = civic / urban planner | Frames the output as aggregate decision-support, not single-cell verdicts. Drives the heatmap + horizon-toggle UI |
| All three horizons (nowcast + 1-2 yr + 5 yr) | User wanted comprehensive coverage. We compensate with honest per-horizon confidence |
| Composite signal (built-up + densification + capital) | Captures growth as a multi-dimensional phenomenon; single metric is reductive |
| 4×4m DigiPin cell as the grain | Consistent with portal identity. Smoothing/interpolation from coarser sources handled in the data pipeline |
| Single-PR delivery, all three layers, lower fidelity | "Hybrid B'" — explicit trade-off between speed and per-horizon depth. 5-year is extrapolation, 1-2 yr is RERA-MP-only |
| Reuse the Van Suraksha service account for GEE | Pragmatic for personal/research use. No design changes; clean separation deferred to Phase 2 |
| In-repo COG hosting for v1 | 175 MB total, comfortably under GH Pages cap. Cloudflare R2 is the Phase 2 upgrade path matching `DIGITAL_TWIN_ARCHITECTURE.md` |
| Toolbar button (not sidebar query mode) | Single render path matches existing map-overlay toolbar entries (LCZ, Buildings, LULC). Sidebar reserved for analytical multi-cell queries |
| Collapsible Methods · Limitations panel | Panel real estate is precious; planners can opt-in to detail. Confidence band stays always-visible alongside the composite score |

## 4. Architecture

```
Once-per-deploy (Python pipeline, runs locally or in GH Actions cron)
   ┌─────────────────────────────────────────┐
   │  data/growth/                            │
   │  ├── buildings_temporal_2016-2023.tif    │  ← Google Open Buildings Temporal V1
   │  ├── viirs_2016-2024.tif                 │  ← NASA/GEE annual night lights
   │  └── ghsl_pop_2025.tif                   │  ← EU JRC GHSL population grid
   │                                          │
   │  data/realtime/rera_mp/latest.json       │  ← CI-managed scraper (existing framework)
   └─────────────────────────────────────────┘
                       │
                       │  static GET (GitHub Pages, future: Cloudflare R2)
                       ▼
   ┌─────────────────────────────────────────┐
   │  js/realtime-growth.js                   │
   │  ─ Probes COGs at cell lat/lng           │
   │  ─ Fetches RERA polygons in 2 km radius  │
   │  ─ Reads OSM construction signals from   │
   │    data-fetcher.js (already integrated)  │
   └─────────────────────────────────────────┘
                       │
                       ▼
   ┌─────────────────────────────────────────┐
   │  js/growth-score.js (pure functions)     │
   │  ─ BUE / DEN / CAP sub-scores            │
   │  ─ Per-horizon composites                │
   │  ─ Per-cell confidence bands             │
   └─────────────────────────────────────────┘
                       │
                       │  result.realtime.growth = { nowcast, year_2, year_5, drivers }
                       ▼
   ┌─────────────────────────────────────────┐
   │  Three surfaces:                         │
   │  ─ js/growth-widget.js  (panel section)  │
   │  ─ js/growth-overlay.js (map heatmap)    │
   │  ─ js/disha.js          (LLM context)    │
   └─────────────────────────────────────────┘
```

**Two timescales of data, deliberately separated:**

- **Slow tier** (offline, refresh quarterly) — heavy raster + RERA snapshots, built by a Python module under `pipeline/growth/` and committed as artifacts to `data/growth/`.
- **Fast tier** (per cell click) — sample the offline rasters at the cell's coordinates, fuse with live OSM construction signals. Per-click budget: <300 ms.

**Why this split**: a planner expects the forecast to load fast. Doing the GEE export work in the browser would not. Pre-computing as Cloud-Optimized GeoTIFFs lets the browser do only the pixel lookup at click time, served via HTTP-range requests using `georaster.browser.bundle.min.js` (already loaded for the flood DEM in PR #10).

### 4.1 Result schema

The orchestrator populates `result.realtime.growth` with this exact shape (JSDoc / TypeScript-style for unambiguous implementation):

```javascript
result.realtime.growth = {
    // 0-100, the active-horizon composite chosen by widget toggle (defaults to "nowcast")
    active_horizon: "nowcast" | "year_2" | "year_5",

    horizons: {
        nowcast: {
            composite: number,            // 0-100; or null if all sub-scores are null
            confidence_band: number,      // always 5 for nowcast
            sub_scores: {
                bue: { value: number|null, direction: "▲"|"▶"|"▽", driver: string },
                den: { value: number|null, direction: "▲"|"▶"|"▽", driver: string },
                cap: { value: number|null, direction: "▲"|"▶"|"▽", driver: string }
            },
            // Effective weights after re-normalisation (sum to 1.0; if a sub_score is null its weight redistributes)
            effective_weights: { bue: number, den: number, cap: number },
        },
        year_2: { /* same shape; confidence_band = 10 */ },
        year_5: {
            /* same shape; confidence_band = per-cell value from 5-year r² formula */
            r_squared: number,            // 0-1, source of the band width
        },
    },

    // Per-source availability for telemetry + disclosure
    sources: {
        buildings_temporal: "ok" | "stale" | "missing",
        viirs:              "ok" | "stale" | "missing",
        ghsl_pop:           "ok" | "missing",
        rera_mp:            "ok" | "stale" | "missing" | "out_of_state",
        osm:                "ok" | "missing",
    },

    // Filled in by the orchestrator at fetch time, used by the panel for the "as of" timestamp
    generated_at_iso: string,
};
```

When every source returns `missing`, `result.realtime.growth = null` (not an empty object) — the widget treats this as the unavailable-data case described in §8.2.

## 5. Score model

Three dimension sub-scores, each clamped 0–100:

```
BUE — Built-up expansion
   anchor 50
   + 25 · tanh( open_buildings_temporal_yoy_pct(2022→2023) / 8 )
   + 15 · tanh( height_yoy_change_m )
   + min(10, osm_construction_count · 2)

DEN — Densification
   anchor 50
   + 25 · tanh( ghsl_pop_5yr_pct / 15 )
   + min(15, osm_commercial_density / 8)

CAP — Capital flow
   normLog(
     Σ over RERA projects in 2 km radius:
       project_value · exp(-age_yrs / 2) · exp(-distance_km / 1.5),
     anchor = 500_000_000   // rupees
   )
```

Why `tanh` instead of `min(100, x)`: percentage changes are unbounded; `tanh` gives a smooth S-curve where ±10% saturates near the upper limit while preserving linear feel in the middle range. Why `exp(-age) · exp(-distance)` for RERA: capital flow effects decay smoothly in both time and space; ~1.5 km is roughly one Indian Tier-2 city ward.

**Per-horizon composites** — weights shift toward the dominant signal for that horizon:

| Horizon | Weights (BUE / DEN / CAP) | Rationale |
|---|---|---|
| **Nowcast** | 0.40 / 0.30 / 0.30 | All three matter for "what just happened" |
| **1–2 year** | 0.20 / 0.20 / 0.60 | RERA pipeline is by far the most predictive near-term signal |
| **5-year** | extrapolation: linear regression over 8-year building presence history | The honest weakness — we extrapolate, not predict |

**Per-cell confidence bands**:

| Horizon | Band | Notes |
|---|---|---|
| Nowcast | ±5 | Signal noise only |
| 1–2 year | ±10 | RERA pipeline can slip or be cancelled |
| 5-year | `±25 · (1 - r²_clamped)`, floor ±10 | Tighter for stable trends, wider for noisy cells |

**Composite re-weighting on null sub-scores**: if a source is missing for a state (e.g., no RERA data), the missing dimension drops out and the remaining weights renormalise to sum to 1. UI surfaces this as `Capital: — (no data for state)`.

## 6. Data sources & pipeline

| # | Source | Role | Refresh | Auth | Output |
|---|---|---|---|---|---|
| 1 | Google Open Buildings Temporal V1 (GEE) | BUE primary | Yearly | GEE service account (`van-suraksha-alert` project reused) | 8-band COG, ~80 MB |
| 2 | NASA VIIRS Night Lights (GEE) | Supporting BUE + DEN | Quarterly | GEE service account | 9-band COG, ~40 MB |
| 3 | EU JRC GHSL Population Grid | DEN primary | Static (5-year release) | None, CC-BY 4.0 | Single COG, ~50 MB |
| 4 | OSM construction POIs (Overpass) | Live nowcast tweak | Per click | None | Already integrated in `data-fetcher.js` |
| 5 | RERA Madhya Pradesh (state portal) | CAP for 1-2 year | Weekly cron | None (`--insecure` for SSL) | GeoJSON, ~5 MB |

### Pipeline structure

```
pipeline/growth/
├── requirements.txt          # earthengine-api, rasterio, rio-cogeo, geopandas
├── extract_buildings_temporal.py  # GEE → 8-band COG (2016-2023)
├── extract_viirs_annual.py        # GEE → 9-band COG (2016-2024)
├── download_ghsl_pop.py           # One-off CC-BY download → single COG
├── stack_to_multiband.py          # Combines annual rasters into multi-band COGs
└── README.md                       # GEE auth, refresh procedure

scrapers/sources/
└── rera_mp.py                # Plugs into existing realtime scraper framework
                              # Outputs data/realtime/rera_mp/latest.json
```

The Python scripts run **once per refresh** (locally or via a CI cron). The RERA scraper extends the existing 15-minute cron framework with a weekly schedule override.

### Authentication

GEE service account from the existing `van-suraksha-alert` GCP project is reused. The full JSON credentials file lives locally at `~/.gee/digipin-credentials.json` (gitignored) and as a GitHub Actions secret `GEE_SERVICE_ACCOUNT_JSON`. The pipeline reads `GOOGLE_APPLICATION_CREDENTIALS` env var (local) or the CI secret (remote).

### Browser data access

The browser never calls the RERA scraper directly. It reads the **pre-built static `latest.json`** that the existing scraper framework writes (same pattern as `data/realtime/ndma_sachet/latest.json` from PR #5):

```javascript
// 1. Four parallel COG range fetches (tile math from flood-inundation.js)
const [buildings, heights, viirs, pop] = await Promise.all([
    getValuesAtPoint(cog_buildings_temporal, lat, lng),  // → [p_2016, ..., p_2023]
    getValuesAtPoint(cog_heights, lat, lng),             // → [h_2016, ..., h_2023]
    getValuesAtPoint(cog_viirs, lat, lng),               // → [v_2016, ..., v_2024]
    getValuesAtPoint(cog_ghsl_pop, lat, lng),            // → scalar
]);

// 2. RERA: load the state's static GeoJSON snapshot, point-in-radius filter client-side
const reraSnapshot = await fetch('data/realtime/rera_mp/latest.json', { cache: 'no-store' });
const reraProjects = reraSnapshot.records.filter(p =>
    haversine_km(p.lat, p.lng, cellLat, cellLng) <= 2.0
);

// 3. OSM construction signals: re-use the count already in result.categories.landuse.features.construction
// (no extra fetch — data-fetcher.js already populated it during the main cell fetch)
```

The RERA file is `~5 MB` for MP-only v1, fetched once with a 5-minute in-memory TTL (matches the realtime-alerts.js pattern). Browser-side filtering is fast (a few hundred polygons, distance check is O(n)).

**Cell outside any RERA-supported state**: `sources.rera_mp = "out_of_state"`, CAP sub-score = null, composite re-weights remaining dimensions.

Total hosted payload: **~175 MB** in `data/growth/` + `~5 MB` in `data/realtime/rera_mp/`. Under GH Pages' 1 GB cap. Phase 2: move to Cloudflare R2 to align with `DIGITAL_TWIN_ARCHITECTURE.md`.

## 7. UI / UX

Three surfaces:

### 7.1 Cell detail panel widget

A new widget below the existing flood-forecast widget. Three-horizon toggle, composite score with confidence band, driver attribution by dimension, methods/limitations disclosure.

```
┌──────────────────────────────────────────────────────────┐
│  📈 Growth Forecast                       [HIGH GROWTH]   │
│  ──────────────────────────────────────────────────────  │
│  Horizon:  [ Now ]  [ 1–2 yr ]  [ 5 yr ]                 │
│                                                           │
│  Composite:  74  (±10 confidence)                         │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                           │
│  Why this cell:                                            │
│    Built-up    ▲ 82   +14% building presence YoY          │
│    Densify     ▲ 65   pop grid +5% (2020→2025)            │
│    Capital     ▶ 71   3 RERA projects within 2 km         │
│                                                           │
│  [ Show on map ]                                          │
│                                                           │
│  ⓘ Methods · Limitations                                  │
└──────────────────────────────────────────────────────────┘
```

Horizon toggle is sticky across cell clicks — switching cells while in "1–2 yr" mode keeps that mode. Stored in module state, not the URL.

### 7.2 Map heatmap overlay

Toggleable via a new toolbar button `btn-growth` alongside `btn-heatmap`, `btn-lcz`, etc. When active, visible cells are coloured by their composite score for the active horizon. Cells with confidence > ±20 render at 60% opacity; high-confidence cells render at full opacity. Reuses `js/heatmap-overlay.js` infrastructure (same `addSource` / `addLayer` MapLibre pattern, same cell-grid render).

### 7.3 DISHA LLM context

Two new lines in DISHA's context block, no UI work:

```
Growth (nowcast):   composite=74 conf=±10  signals: built-up +14% YoY, RERA pipeline strong
Growth (5-year):    composite=82 conf=±25  trend: linear extrapolation, building presence trajectory
```

Lets DISHA answer questions like *"is this neighbourhood likely to densify?"* with grounded score citations.

### 7.4 Disclosure

Two layers, both important:

1. **Confidence band always visible** alongside the composite score (`74 (±10 confidence)`). Click the ⓘ icon for a tooltip.
2. **Methods · Limitations panel** — collapsible, opens to a short readable block disclosing data sources, the per-horizon confidence rationale, and the explicit statement that the 5-year layer is direction-of-travel rather than prediction.

### 7.5 Component files

```
js/realtime-growth.js     # fetches COGs + RERA, returns scored composites per horizon
js/growth-score.js        # pure functions for the math in Section 5
js/growth-widget.js       # panel UI (DOM-based, no Canvas needed)
js/growth-overlay.js      # map heatmap toggle (reuses heatmap-overlay.js infrastructure)
css/styles.css            # appended `.growth-widget` block matching flood-widget theme
```

Module boundaries follow the harness principles from PR #12 — fetch / score / present are three separable concerns. `growth-score.js` has no DOM, no fetch, no MapLibre — pure functions, fully testable.

## 8. Confidence, error handling, testing

### 8.1 Confidence semantics (recap)

Three places confidence shows up, all consistent:

| Surface | Treatment |
|---|---|
| Panel widget | `74 (±10 confidence)` always visible next to composite |
| Map overlay | Confidence > ±20 → 60% opacity; full opacity otherwise |
| DISHA context | `conf=±10` token in prompt for LLM modulation |

The 5-year band is **per-cell, not fixed**: `band_5yr = 25 · (1 - r²_clamped)`, floor ±10. The most important honesty in the design.

### 8.2 Error handling

| Failure mode | Detection | Graceful behaviour |
|---|---|---|
| GEE auth expires / quota exceeded | Pipeline build fails | CI alerts maintainer; portal continues serving last-good COGs (they're static artifacts; freshness disclosed via `sources.X = "stale"` in the result) |
| Single COG fetch fails (CORS, network, missing tile) | `getValuesAtPoint()` rejects | That source set to `"missing"`; composite re-weights remaining sub-scores. **No retry within the click** — user can re-click the cell to retry (treated as a fresh fetch) |
| **All four COG fetches fail simultaneously** | All sources report `"missing"` AND no RERA AND no OSM signal | `result.realtime.growth = null`. Widget renders "Growth data unavailable for this cell" with a "Try again" link that re-triggers the cell fetch. No error toast (would be noisy on slow networks) |
| RERA scraper SSL fails | `requests.get(verify=False)` already in source (PR #6 pattern) | Source skips gracefully; latest.json contains last successful scrape; `sources.rera_mp = "stale"` |
| RERA snapshot is older than 14 days | Browser checks `generated_at_iso` in the JSON envelope | `sources.rera_mp = "stale"`, CAP still computed but flagged in disclosure tooltip |
| Degenerate r² (identical or single year of data) | NaN/inf in trend regression | Defaults: composite_5yr = nowcast, band = ±25 floor, tooltip discloses "insufficient temporal data" |
| Cell outside India coverage | Pixel-out-of-bounds on tile fetch (returns `null` from georaster) | Widget shows "Outside coverage area — currently India only" |
| Cell inside India but outside RERA state coverage | `sources.rera_mp = "out_of_state"` | CAP sub-score null, composite re-weights; UI shows `Capital: — (no RERA data for state)` |
| Single dimension sub-score null | `null` returned by sub-score | Composite re-weights remaining dimensions; missing shown as `—` in breakdown |
| Source slow (any single fetch > 80 ms × 3 consecutive cells) | Per-source rolling latency tracking in `realtime-growth.js` | Source auto-disabled for the rest of the session; logged to console; user gets remaining sub-scores |

### 8.3 Testing strategy

**Vitest (frontend, PR #3's scaffolding):**

```
tests/growth-score.test.js
   ─ BUE / DEN / CAP sub-scores: known inputs → known outputs
   ─ tanh saturation: ±50% input maps near ±25 ceiling
   ─ Linear trend: 8-point synthetic series → expected slope
   ─ Composite re-weighting: one dimension null → others sum to 1
   ─ Confidence band: r² = 1.0 → ±10; r² = 0 → ±25

tests/realtime-growth.test.js
   ─ Mock getValuesAtPoint → verify sub-score wiring
   ─ Verify graceful null returns when a layer is missing
```

**Pytest (pipeline, PR #3's pytest.ini):**

```
pipeline/growth/tests/test_extract_buildings_temporal.py
   ─ Import smoke; verify earthengine-api initialises
   ─ Mock GEE → assert COG output schema (8 bands, dtype)

scrapers/sources/tests/test_rera_mp.py
   ─ Mock RERA portal HTML → assert parser produces expected GeoJSON
   ─ SSL retry logic: first fail then succeed
```

**Playwright (UI smoke, PR #12's MCP):**

```
tests/playwright/growth-widget.spec.js
   ─ Click an Indore cell → growth widget renders within 500 ms
   ─ Toggle horizon: composite + breakdown update
   ─ Toolbar "Growth" button: heatmap source/layer added; click again → removed
   ─ Outside-India cell: shows coverage message, no error toast
```

The `maplibre-layer-reviewer` and `scraper-source-reviewer` subagents (PR #12) automatically review the relevant files on PR open.

### 8.4 Performance budget

| Step | Budget |
|---|---|
| Single COG range fetch | 80 ms |
| All 4 source fetches (parallel) | 250 ms p95 |
| Score computation (browser) | 5 ms |
| Widget render | 30 ms |
| **Total panel-load delta** | **<300 ms** |

If any source exceeds its budget for 3 consecutive cell clicks, the source is automatically disabled for the session (logged) — the user gets the remaining sub-scores rather than a slow panel.

## 9. Open questions / future work

- **Cloudflare R2 hosting migration** when the dataset grows beyond GH Pages comfort (>500 MB)
- **Multi-state RERA scrapers** — add Karnataka, Maharashtra, Tamil Nadu using the existing source-per-state convention
- **CA-MARKOV or transformer-based forecasting** for the 5-year layer to replace linear extrapolation
- **Master-plan zoning integration** — state development corporation plans add real forward signal
- **Transaction-history calibration** — RERA project values are notional; transaction data (when accessible) would let us calibrate the CAP score against actual market clearance
- **Confidence-band rendering on the map heatmap** — currently uses opacity; future could use a hatched pattern for high-uncertainty cells
- **Time-series sparkline for BUE** — show the 8-year building-presence trajectory inside the panel widget alongside the composite score

## 11. Implementation prerequisites

These are **load-bearing checks** that must pass before the implementation plan is committed. Each blocks a different layer of the design.

### 11.1 GEE service account verification

**What**: confirm that the `enetra@van-suraksha-alert.iam.gserviceaccount.com` service account (reused per Section 6) is:

- Active in the `van-suraksha-alert` GCP project
- Authorised for Earth Engine API access (`https://www.googleapis.com/auth/earthengine`)
- Has sufficient EE quota for the export jobs (a one-time India bbox export of Open Buildings Temporal + VIIRS is on the order of 2-4 GB of compute, well within free-tier limits but should be confirmed)
- Has the full private-key JSON available outside this repo and ready to be set as the GitHub Actions secret `GEE_SERVICE_ACCOUNT_JSON`

**Verification step** (run locally before kicking off the implementation plan):

```sh
export GOOGLE_APPLICATION_CREDENTIALS=~/.gee/digipin-credentials.json
python -c "
import ee
ee.Initialize()
print('asset:', ee.ImageCollection('GOOGLE/Research/open-buildings-temporal/v1').first().getInfo()['id'])
"
```

If this prints an asset ID, prerequisite met. If it errors, the implementation pause until the account is provisioned or a fresh `digipin-portal` GCP project is created (see Section 6 alternative).

### 11.2 Flood-widget visual pattern availability

**What**: Sections 7 and 7.5 reference the "flood-widget visual language" as a reuse target — that pattern lives in `js/flood-animation.js`, `js/flood-inundation.js`, `js/flood-scs.js`, and `css/styles.css` (the `.flood-widget__*` block), all currently on branch `agents/flood-scs-slider` (PR #11), not yet merged to `main`.

**Resolution paths** (pick one before implementation):

1. **Wait for PR #11 to merge** (PRs #8 → #9 → #10 → #11 are stacked; merging the chain makes the pattern available on main)
2. **Re-implement the visual pattern from scratch** in `css/styles.css` as part of the growth-widget PR. Adds ~100 LOC of CSS but unblocks the implementation immediately
3. **Adopt a simpler dark glass-morphism style** that doesn't require the flood-widget primitives. Lowest fidelity but ships fastest

Default recommendation: **wait for PR #11** — keeps the visual language consistent across forecast features. If PR #11 is blocked for any reason, fall back to path 2.

### 11.3 RERA Madhya Pradesh portal access

**What**: confirm that `rera.mp.gov.in` is still serving the project list with the same SSL legacy-renegotiation issue identified during earlier probing. The scraper relies on `verify=False` in `requests.get()`; if the portal upgrades its certificate chain, this becomes unnecessary; if it changes its HTML structure, the parser needs updating.

**Verification step**:

```sh
curl -k -A "Mozilla/5.0" https://rera.mp.gov.in/ | head -50
```

Confirm: HTML returned (not a JavaScript shell), project-listing path discoverable. If the portal has changed materially, treat the 1-2 year horizon as **degraded** for v1 — populate CAP from OSM construction signals alone and disclose explicitly in the methods panel.

## 12. References

- Brainstorm session: this file's commit history
- Open Buildings Temporal V1: <https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1>
- Open Buildings V3: <https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings_v3_polygons>
- GHSL Population Grid: <https://ghsl.jrc.ec.europa.eu/ghs_pop2023.php>
- VIIRS Night Lights (GEE): asset `NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG`
- Existing flood widget pattern (PR #11): <https://github.com/Slllyio/digipin/pull/11>
- Subagent review framework (PR #12): <https://github.com/Slllyio/digipin/pull/12>
- DigiPin Digital Twin Architecture: `docs/DIGITAL_TWIN_ARCHITECTURE.md`
- Research Integration roadmap: `docs/RESEARCH_INTEGRATION.md`
