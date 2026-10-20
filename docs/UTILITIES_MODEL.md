# Utilities & Infrastructure (per-cell)

A cell-panel section that surfaces seven utility / infrastructure readings for a
clicked DIGIPIN cell. Every reading carries a **source badge** so it is clear
what is measured, OSM-derived, modeled, or a regional reference — consistent
with the app's source-tracked philosophy. No reading claims per-building utility
records (which do not exist as open data for arbitrary Indian locations).

| # | Reading | Source | Granularity |
|---|---------|--------|-------------|
| 1 | Sound / noise pollution | **Modeled** from the quietness score (road + land-use proximity) | per-cell |
| 2 | Ground water level (depth to table) | **Regional reference** (CGWB / India-WRIS) | pilot region |
| 3 | Sewer lines | **OSM** `man_made=pipeline[substance=sewage]`, `manhole`, `wastewater_plant` | nearest within radius |
| 4 | Water pipelines | **OSM** `man_made=pipeline[substance=water]`, `water_works/well/tower`, `amenity=drinking_water` | nearest within radius |
| 5 | Gas connection (PNG) | **Regional reference** (PNGRB CGD area) + OSM gas pipelines | city/area + OSM |
| 6 | Ground water quality | **Regional reference** (CGWB district quality) | pilot region |
| 7 | Electricity connection type | **OSM** `power=cable` (underground) vs `power=line/minor_line` (overhead) + substations; regional operator | nearest within radius |

## How it works

- **No extra network call.** The cell's existing Overpass query already fetches
  `power` elements; this feature adds `man_made=pipeline|water_works|water_well|
  wastewater_plant|reservoir_covered|manhole|gasometer` and `amenity=drinking_water`
  to the *same* query (`buildOverpassQuery` in `js/data-fetcher.js`). The infra
  readings (3, 4, 5-pipes, 7) are then derived from those already-fetched elements.
- **`js/utilities.js`** exposes a pure `assess(elements, ref, opts)` that returns
  the seven readings, plus `loadReference()` (best-effort, retryable) for the
  bundled regional file. The orchestrator (`_doFetchAllFeatures`) calls them after
  scores are computed and stores the result on `result.utilities`; `result.sourceStatus.utilities`
  reflects availability.
- **`js/panel.js`** renders `buildUtilitiesHTML(data)` as a "Utilities &
  infrastructure" card in the cell panel.

### Electricity type inference
`underground` (cables) + `overhead` (lines/minor_lines) presence →
`underground` / `overhead` / `mixed`; substations-or-transformers only →
`overhead`; nothing mapped → `unknown` (shown as "Typical: overhead LV" with the
regional operator). Nearest substation distance is reported when present.

### Noise band
`noise = 100 − quietness_score` mapped to bands: ≤25 `~<50 dB` (good),
≤50 `~50–60 dB` (moderate), ≤70 `~60–70 dB` (elevated), else `>70 dB` (high).

## Regional reference

`data/utilities/<region>/reference.json` (Indore pilot bundled). Readings 2, 5,
6 only render inside the region's `bounds`; elsewhere they show "pilot only".
The Indore values are grounded in public facts:

- **Ground water:** Indore assessment unit is CGWB-classified **Over-Exploited**;
  the depth figure is a representative district depth-to-water, not a per-cell
  measurement.
- **Ground water quality:** CGWB district quality — generally potable with
  moderate hardness and locally elevated nitrate.
- **Gas (PNG):** Indore is an authorised **City Gas Distribution** area operated
  by **Avantika Gas Ltd** (PNGRB).
- **Electricity operator:** **MPPKVVCL** (MP Paschim Kshetra Vidyut Vitaran Co.).

To extend to a new region, add `data/utilities/<region>/reference.json` with the
same shape and matching `bounds`.

## Limitations

- OSM pipe/sewer coverage in Indian cities is **sparse**; "none mapped nearby"
  is common and honest — it does not mean no network exists.
- Ground water and PNG are **regional**, not per-cell; they are reference context.
- Noise is a **structural estimate** (no live acoustic sensors).

## Tests

`tests/utilities.test.js` — pure coverage of `regionHas`, `noiseFromQuietness`,
and `assess` (electricity inference, pipe counting, regional gating, empty input).
