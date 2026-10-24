# Per-cell data store + layer registry

One storage shape for **every** dataset keyed by DIGIPIN cell, and one renderer
that plots any of them, in 2D or as 3D extruded cells, with no per-layer code.

```
 any source ──▶ pipeline/cells (bin to cells) ──▶ data/cells/ ──▶ CellStore ──▶ CellLayers
 (grids, shards,    build.py · ingest.py           catalog.json     (js)          (2D / 3D)
  CSV, GeoJSON)                                    <id>/<region>.json
                                                   <id>/<region>.parquet ──▶ DuckDB-WASM SQL
 dropped file ──▶ CellIngest (same binning, in the browser) ──▶ CellStore.register()
```

## Why DIGIPIN cells are the join key

DIGIPIN is a strict 4×4 quadtree over India, so:

- **A code's prefix is its parent cell.** `34PLLMP` (L7) sits inside `34PLLM`
  (L6). Rolling a fine dataset up to a coarse one is `substr(code, 1, L)`, with
  no spatial join.
- **Cells are exact rectangles.** A cell's bounds come from its code alone, so
  the store only keeps the code, never the geometry. The GeoParquet copy adds
  WKB polygons for GIS tools.
- **Any two datasets join on code** at the coarser of their levels.

### Level ↔ cell size

| Level | Cell edge | Indore pilot bbox (cells) | Typical use |
|---:|---:|---:|---|
| 4 | ~15.7 km | ~9 | district |
| 5 | ~3.9 km | ~144 | city zones |
| 6 | **~978 m** | 2,209 | city-wide scores (`scores`) |
| 7 | **~245 m** | 33,489 | road / grid datasets (`traffic`, `mobility`) |
| 8 | ~61 m | ~532k | point data, block level |
| 10 | ~3.8 m | — | a full DIGIPIN address |

Exact sizes for all ten levels, the hierarchy API and how the map picks a
level per zoom: [DIGIPIN_LEVELS.md](DIGIPIN_LEVELS.md). Older docs said "level
6 ≈ 244 m"; 244 m is level 7.

### Rolling up the hierarchy

`CellStore.rollup(spec, table, level)` / `CellStore.loadAt(id, level)` turn
any dataset into a coarser one by code prefix, combining child cells with the
field's `agg` (`mean` → mean of children, `sum`/`count` → sum, `min`/`max`/
`mode`/`any` carry over). Rolled tables carry `counts` (native cells per
parent) and `nativeLevel`. CellLayers uses this for level of detail: a dataset
draws one level finer than the map grid, capped at its native level, so a
zoomed-out city shows ~1 km or ~4 km parents and a zoomed-in one the native
cells.

## On-disk layout (`data/cells/`)

```
catalog.json                     the layer registry
<dataset>/<region>.json          columnar JSON: what the browser reads
<dataset>/<region>.parquet       GeoParquet 1.1: DuckDB(-WASM), QGIS, geopandas
```

Both files hold the same table: one row per cell **that has data** (sparse),
sorted by code.

### `catalog.json`

```jsonc
{
  "version": 1,
  "generated": "2026-10-20T18:20:47Z",
  "datasets": [{
    "id": "traffic",                       // [a-z][a-z0-9_]*, the view name in SQL
    "title": "Traffic congestion (structural)",
    "description": "…", "source": "pipeline/traffic/traffic_grid.py", "license": "ODbL",
    "group": "Cell Data",                  // Layers-panel group
    "level": 7, "approxCellM": 244,
    "fields": [{
      "key": "congestion_risk", "label": "Congestion risk",
      "type": "number",                    // number | category | boolean
      "agg": "max",                        // how samples in one cell combine
      "unit": "0-100", "domain": [0, 100], // legend extent (data-derived if omitted)
      "ramp": "reds",                      // viridis | reds | greens | blues | heat | diverging
      "higherIs": "worse"                  // optional: better | worse
    }, {
      "key": "worst_los", "type": "category", "agg": "max",
      "domain": ["A","B","C","D","E","F"], "colors": {"A": "#31a354", "F": "#7f0000"}
    }],
    "default": { "field": "congestion_risk", "extrude": false, "heightM": 300 },
    "regions": [{
      "name": "indore_pilot", "cells": 1991,
      "bbox": {"west": …, "south": …, "east": …, "north": …},
      "json": "traffic/indore_pilot.json",
      "parquet": "traffic/indore_pilot.parquet"   // null for a JSON-only build
    }]
  }]
}
```

**Aggregations** (`agg`): `mean`, `sum`, `min`, `max`, `count` (samples in the
cell, regardless of value), `mode` (most common; ties go to the smallest value),
`any` (boolean OR), `first`. `min`/`max` on text compare lexically, so LOS
`"A"…"F"` ranks correctly. Nulls are ignored, and a cell whose fields are all
null is dropped.

### `<dataset>/<region>.json` (columnar)

```json
{ "version": 1, "dataset": "traffic", "region": "indore_pilot", "level": 7,
  "fields": ["congestion_risk", "worst_los"],
  "cells":   ["34PLL56", "34PLL58"],
  "columns": { "congestion_risk": [100, 100], "worst_los": ["F", "F"] } }
```

Floats are rounded to 4 decimals. `columns[k][i]` belongs to `cells[i]`.

### Sharding (big regions)

A region with more than 8,192 cells is split by code prefix, so the browser
fetches only the part it needs. The region entry then carries a `shards`
block, and `json` becomes a template:

```jsonc
{ "name": "indore_pilot", "cells": 30611,
  "json": "growth/indore_pilot/{prefix}.json",            // one columnar file per key
  "shards": { "prefixLen": 4, "keys": ["34M5", "34M6", …] },
  "parquet": "growth/indore_pilot.parquet" }             // always a single file
```

The prefix length is `level - 3`, so each shard holds at most 4,096 cells
(L7 → 4-character keys, L8 → 5). `write_dataset(…, shard="auto" | None | n)`
picks or forces the layout. Re-running it removes the files of the other
layout. `store.read_region(root, entry)` reads either layout back. An
unsharded region keeps the plain `"json": "<id>/<region>.json"`, so v1
readers still work.

### `<dataset>/<region>.parquet` (GeoParquet 1.1)

| column | type | notes |
|---|---|---|
| `digipin` | string | dash-less code at `level`: the key |
| `level` | int8 | |
| `lat`, `lng` | double | cell centre |
| *fields…* | double / string / bool | one per catalog field |
| `bbox` | struct{xmin,ymin,xmax,ymax} | GeoParquet 1.1 bbox covering, for fast filtering |
| `geometry` | binary (WKB Polygon) | cell rectangle, OGC:CRS84 |

The file metadata carries `geo` (the GeoParquet spec block) and `digipin_cells`
(the dataset's catalog entry), so a parquet file describes itself. This was
checked by reading the files with geopandas and DuckDB.

## Adding data

**1. From existing pipeline output (built-ins).** `pipeline/cells/build.py`
lists each dataset as a `DatasetSpec` paired with a reader:

```sh
pip install -r pipeline/cells/requirements.txt   # pyarrow, for GeoParquet
python -m pipeline.cells.build --region indore_pilot             # scores, traffic, mobility, growth
python -m pipeline.cells.build --region indore_pilot traffic     # just one
python -m pipeline.cells.build --no-parquet                      # stdlib only
```

The *Precompute scores* workflow runs the `scores` step after each city build,
so a new city appears in the store automatically.

**Open datasets for all metros.** Population, land cover, vegetation, terrain,
water/flood, night lights, heat, air quality, rainfall, building stock, soil,
travel time (Earth Engine) and OSM amenities/roads are baked by
`pipeline/cells/ee_layers.py` and `osm_layers.py`; see
[OPEN_DATA_CELLS.md](OPEN_DATA_CELLS.md).

**Raster (GeoTIFF) datasets.** Use `adapters.raster_records` for any EPSG:4326
GeoTIFF. It picks the sampling method from the resolution. When pixels are
finer than cells, it emits one record per pixel, and the field's `agg`
combines them: `mean` for a zonal mean, `sum` for counts such as population.
When pixels are coarser than cells, every cell samples the pixel under its
centre. A new raster dataset is one function plus a `BUILTINS` entry:

```python
def build_ndvi(region, level=7):
    spec = DatasetSpec(id="ndvi", title="Vegetation (NDVI)", level=level,
                       group="Open Data (satellite)", fields=[
        FieldSpec("ndvi_2024", "NDVI 2024", agg="mean", domain=[-1, 1], ramp="greens"),
        FieldSpec("ndvi_change", "NDVI change 2016→24", agg="mean", ramp="diverging"),
    ])
    return raster_dataset(spec, DATA / "ndvi" / f"{region}.tif",
                          bands={"ndvi_2016": 1, "ndvi_2024": 9},         # raw bands (1-based)
                          derive={"ndvi_change": lambda r: r["ndvi_2024"] - r["ndvi_2016"]},
                          keep=lambda r: r["ndvi_2024"] is not None)       # stay sparse
```

`derive` keys may convert units or compute changes between years. Band keys
that are not fields are dropped. Data that lives in Earth Engine rather than
in a local GeoTIFF is written straight to the store by
`pipeline/cells/earthengine.py`, which uses the same `write_dataset` call.
`growth` (Open Buildings Temporal 2016→2023 + CA-ML P(urban 2035), L7) is
the built-in example.

**2. Any CSV / GeoJSON (no code).**

```sh
python -m pipeline.cells.ingest hospitals.csv --id hospitals --title "Hospitals" --level 8
python -m pipeline.cells.ingest wards.geojson --id wards --level 7 --agg population=sum
```

The location comes from a `digipin` / `digipin_code` / `pin` column, from
`lat|latitude|y` + `lng|lon|long|longitude|x` columns, or from GeoJSON geometry
(a Point, or the vertex-bbox centre of anything else). Every row adds to
`count`. Numeric columns become `mean` fields and text columns with 24 or fewer
distinct values become `mode` categories. Free text is skipped.

**3. In the browser (drag and drop).** Drop a CSV or GeoJSON on the map, or
pick one from **Layers → Ingested data → Plot a CSV / GeoJSON file…**. The file
is binned in the page by `js/cell-ingest.js`, using the same inference and
binning as `ingest.py`. It is registered in the store and drawn as 3D cells.
The cell size is chosen from the data's extent (city → L7, neighbourhood → L8)
and can be changed from the legend. Nothing is uploaded. To keep the layer,
commit it with `pipeline.cells.ingest`.

Binning parity is locked by `pipeline/cells/tests/bin_parity.json`. Both pytest
and Vitest assert against this file, so the browser and the pipeline cannot
drift apart.

## Time series

A dataset with a `time` block holds a **series per cell**: one value per step
for every field. The Layers panel lists them under **Time series**, and while
one is on, a slider with play/pause sits at the bottom of the map.

```jsonc
// catalog.json entry (extra key)
"time": { "unit": "month", "steps": ["2024-10", …, "2026-09"], "default": "2026-09" }

// <dataset>/<region>.json: `times` + one array per cell
{ "level": 6, "fields": ["lst_day_c", "lst_night_c"], "times": ["2024-10", …],
  "cells": ["34PLLM", …], "columns": { "lst_day_c": [[33.7, 30.0, …, null, …], …] } }
```

- `unit` is `year`, `month` or `day`; steps are ISO labels, unique and
  ascending. Temporal datasets take number fields only.
- `null` marks a step with no data for that cell (cloud gaps in the monsoon).
- The legend domain spans **every step**, so a colour means the same value in
  every month. `scripts/build_cell_timeseries.py` sets it to the 2nd–98th
  percentile so a single bad pixel does not wash out the ramp.
- GeoParquet stores each field as `list<double>` aligned with `time.steps`
  (in the `digipin_cells` metadata): `SELECT digipin, lst_day_c[7] FROM lst_monthly`
  in DuckDB is April 2025 (1-based).

**Rendering.** `CellStore.toGeoJSON` writes one property per step
(`lst_day_c@0 … @23`). `CellLayers.setTime(id, t)` only swaps the colour and
height expressions to `…@t` with `setPaintProperty`, with no `setData`, so 2D
fills and 3D extrusions animate smoothly even for the 33k-cell NDVI layer.
`js/time-slider.js` builds one timeline from the union of the active temporal
datasets' steps. A dataset missing the current step holds its latest earlier
step. The keyboard works on the focused bar: ←/→ step, Space plays, Home/End jump.

**Inspector.** Clicking a temporal cell shows the values at the current step
and an SVG chart of the cell's whole history for the selected field, with the
current step marked. The chart follows the slider while it is open. **Copy**
adds the series as CSV.

**Built datasets** (all 13 city pilots; monthly ones cover Oct 2024 to Sep
2026; Earth Engine project `van-suraksha-alert`):

| id | level | fields | source |
|---|---:|---|---|
| `lst_monthly` | 6 | `lst_day_c`, `lst_night_c` (°C) | MODIS MOD11A2 + MYD11A2 8-day LST, 1 km |
| `ndvi_monthly` | 7 | `ndvi` | MODIS MOD13Q1 + MYD13Q1 16-day NDVI, 250 m |
| `no2_monthly` | 6 | `no2_umol_m2` (µmol/m²) | Sentinel-5P TROPOMI OFFL L3 tropospheric NO₂ |
| `rain_monthly` | 5 | `rain_mm` (monthly total) | CHIRPS v2.0 daily, ~5.5 km |
| `nightlights_monthly` | 7 | `radiance` (nW/cm²/sr) | VIIRS DNB monthly VCMSLCFG, ~460 m |
| `pm25_monthly` | 5 | `pm25_ugm3` (µg/m³) | CAMS NRT forecast model, ~40 km (modelled, not monitors) |
| `builtup_yearly` | 7 | `built_pct` (% of cell built) | JRC GHSL GHS-BUILT-S R2023A, 1975–2020 every 5 years |
| `landcover_yearly` | 7 | `built_pct`, `trees_pct`, `water_pct`, `crops_pct` (%) | Dynamic World V1 yearly mean class probability, 2016–2025 |
| `co_monthly` | 6 | `co_mmol_m2` (mmol/m²) | Sentinel-5P TROPOMI OFFL L3 CO |
| `aerosol_monthly` | 6 | `aerosol_index` | Sentinel-5P TROPOMI OFFL L3 UV absorbing aerosol index |

Domains are pooled over every city, so a colour means the same value in
Delhi and in Chennai.

```sh
python3 scripts/build_cell_timeseries.py --region all                          # every dataset, every city
python3 scripts/build_cell_timeseries.py --start 2024-10 --months 24 --region delhi,pune ndvi
```

Python: `store.series_table(level, steps, {code: {key: [v…]}}, keys)` builds
the table, and `DatasetSpec(time=TimeSpec("month", steps))` declares it.

## Frontend API

```js
await CellStore.init();                         // loads catalog.json (silent no-op on 404)
CellStore.datasets();                           // registry entries (catalog + runtime)
await CellStore.rowAt('traffic', lat, lng);     // { digipin, level, congestion_risk, … } | null — fetches ≤ 1 shard
await CellStore.rowAt('traffic', lat, lng, 6);  // rolled up to the L6 parent (+ cells: n)
await CellStore.loadCells('growth', ['34PL']);  // only the shards overlapping these code prefixes
await CellStore.load('growth');                 // the whole table (every region + shard)
await CellStore.loadAt('traffic', 5);           // whole table rolled up to L5
await CellProfile.profile(lat, lng, { rank: true });  // every dataset's row for one cell
await CellLayers.show('traffic', { field: 'worst_los', extrude: true });
CellLayers.setField('traffic', 'congestion_risk');
CellLayers.hide('traffic');
await CellStore.sql(`
  SELECT t.digipin, t.congestion_risk, s.livability
  FROM traffic t JOIN scores s ON substr(t.digipin, 1, 6) = s.digipin   -- L7 → its L6 parent
  ORDER BY t.congestion_risk DESC LIMIT 20`);   // DuckDB-WASM, loaded on first call
```

The **Layers** panel builds one group per `group` value. Each dataset gets a
row, with no per-layer code, and the legend has a field picker and a
**3D extruded cells** switch.

**Cell profile.** Clicking a cell opens the panel, which shows an
**Everything in this cell** card (`js/cell-profile.js`). It lists every
registry dataset that covers the cell, including dropped files, with each value
and its rank among the dataset's cells. The rank is green or red when
`higherIs` says which end is good, and each dataset has a **Map** button. The
card paints from local data before the live fetch finishes. A new dataset
appears there with no code.

Config (`window.DIGIPIN_CONFIG`): `cellStore: false` turns the store off,
`cellsBase: 'https://…/cells/'` serves it from R2 or a CDN, and `ingestLevel: 8`
fixes the drop-ingest level.

## What was migrated

- **Score grid** (`js/score-choropleth.js`): now draws from the `scores`
  dataset through CellLayers, which adds any-score selection and 3D. The
  PMTiles path remains as the fallback. Its API (`show`, `setScore`,
  `isActive`, `getScoreKey`) is unchanged, so URL state and DISHA actions work
  as before.
- **Traffic + mobility grids** (`traffic_grid.json`, `mobility_grid.json`):
  their 200 m regular grids are re-binned to L7 DIGIPIN cells as the `traffic`
  and `mobility` datasets. They render from the registry, with no new layer
  code. The road-line overlays (`TrafficOverlay`, `MobilityOverlay`) and the
  cell-panel samplers are unchanged.

## Coverage by city

Which datasets exist for which of the app's 13 cities. The Layers panel only lists
a dataset for the selected city when the catalog has a region with that name, or
a region whose bbox holds the city centre (`CellStore.coversCity`). Layers with
no data there are named in a short "No <city> data yet" line under their group,
and switching city hides any active layer the new city doesn't have.

| Dataset | Source | How it is built for a city |
|---|---|---|
| `scores` | Bulk OSM extract (Geofabrik) + Copernicus DEM | `precompute-scores.yml` (dispatch with a region list) |
| `traffic`, `mobility` | OSM via Overpass | `precompute-cells.yml` (all cities, or a region list) |
| `growth` | Earth Engine: Open Buildings Temporal + CA-ML prediction | `pipeline/growth/*` COGs, then `pipeline.cells.build growth` (needs GEE auth) |
| `*_monthly` time series | Earth Engine (MODIS, Sentinel-5P, CHIRPS, VIIRS, …) | `scripts/build_cell_timeseries.py --region <city>` (needs GEE auth) |

Cell counts per region (`python -m pipeline.cells.coverage --write` regenerates this
table; both precompute workflows run it after a build):

<!-- coverage:start -->
| City | `accessibility` L6 | `aerosol_monthly` L6 | `air_quality` L6 | `air_trend` L6 | `building_dynamics` L7 | `building_stock` L7 | `built_up` L7 | `builtup_yearly` L7 | `bus_service` L7 | `bus_stop_heat` L7 | `climate_future` L5 | `climate_zones` L7 | `co_monthly` L6 | `commute_carbon` L6 | `construction_monthly` L7 | `crossings` L7 | `cycling` L7 | `demographics` L7 | `drains` L7 | `embeddings` L7 | `emergency_access` L7 | `encroachment` L7 | `ev_charging` L7 | `farmland` L7 | `fires` L6 | `flight_paths` L7 | `flood_future` L6 | `freight` L7 | `growth` L7 | `haze_mix` L5 | `heritage` L7 | `humid_future` L5 | `humid_heat` L5 | `job_access` L6 | `lakes` L7 | `land_cover` L7 | `land_value` L7 | `landcover_yearly` L7 | `landmarks` L7 | `landuse` L7 | `lightning` L6 | `lst_monthly` L6 | `mangroves` L7 | `metro_future` L7 | `mobility` L7 | `ndvi_monthly` L7 | `nightlights` L7 | `nightlights_monthly` L7 | `no2_monthly` L6 | `osm_amenities` L7 | `osm_roads` L7 | `osm_walk` L7 | `parking` L7 | `parks` L7 | `places` L7 | `pm25_monthly` L5 | `population` L7 | `power_lines` L7 | `rail_access` L7 | `rain_monthly` L5 | `rainfall` L6 | `re_supply` L7 | `roofs` L7 | `scores` L6 | `sites` L7 | `soil` L7 | `street_infra` L7 | `subsoil` L7 | `surface_heat` L7 | `terrain` L7 | `topsoil` L7 | `traffic` L7 | `traffic_load` L7 | `traffic_noise` L7 | `vegetation` L7 | `water` L7 | `water_history` L7 | `water_risk` L5 | `waterlogging` L7 | `wealth` L6 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| indore_pilot | 2,209 | 2,209 | 2,209 | 2,209 | 33,489 | 33,489 | 33,489 | 33,489 | — | 31 | 156 | 33,489 | 2,209 | 1,383 | 33,489 | 3,624 | 17,793 | 33,448 | 318 | 33,489 | 18,104 | 206 | 18,198 | 28,105 | 2,209 | 33,423 | 2,209 | 970 | 30,611 | 156 | 4 | 156 | 156 | 1,976 | 507 | 33,489 | 7,780 | 33,489 | 10 | 3,465 | 2,209 | 2,209 | — | 610 | 1,761 | 33,489 | 33,489 | 33,489 | 2,209 | 1,574 | 16,996 | 17,202 | 3,292 | 705 | 3,235 | 156 | 33,489 | 3,624 | 18,098 | 156 | 2,209 | 30,658 | 13,677 | 2,209 | 132 | 33,448 | 1,340 | 33,448 | 33,489 | 33,489 | 33,448 | 1,990 | 2,162 | 10,806 | 33,489 | 33,489 | 1,389 | 156 | 33,489 | 2,180 |
| bhopal | 442 | 442 | 442 | 442 | 6,565 | 6,565 | 6,565 | 6,565 | — | 30 | 35 | 6,565 | 442 | 377 | 6,565 | 1,156 | 5,488 | 6,218 | 66 | 6,565 | 4,977 | 257 | 68 | 3,883 | 442 | 6,565 | 442 | 507 | 6,498 | 35 | 1,445 | 35 | 35 | 414 | 661 | 6,565 | 3,446 | 6,565 | 13 | 2,940 | 442 | 442 | — | 220 | 811 | 6,565 | 6,565 | 6,565 | 442 | 760 | 5,259 | 5,240 | 2,263 | 254 | 1,976 | 35 | 6,565 | 732 | 4,970 | 35 | 442 | 6,498 | 4,402 | 442 | 27 | 6,201 | 603 | 6,201 | 6,565 | 6,565 | 6,201 | 969 | 996 | 3,287 | 6,565 | 6,565 | 996 | 35 | 6,565 | 442 |
| pune | 700 | 700 | 700 | 700 | 10,767 | 10,767 | 10,767 | 10,767 | — | 61 | 56 | 10,767 | 700 | 658 | 10,767 | 2,680 | 10,155 | 10,733 | 438 | 10,767 | 9,645 | 778 | 9,664 | 4,482 | 700 | 10,767 | 700 | 1,772 | 10,767 | 56 | 2,655 | 56 | 56 | 697 | 258 | 10,767 | 7,521 | 10,767 | 32 | 5,745 | 700 | 700 | — | 24 | 2,473 | 10,767 | 10,767 | 10,767 | 700 | 2,846 | 9,695 | 9,345 | 5,484 | 1,277 | 5,646 | 56 | 10,767 | 920 | 9,639 | 56 | 700 | 10,767 | 8,921 | 700 | 82 | 10,736 | 3,706 | 10,736 | 10,767 | 10,767 | 10,736 | 3,345 | 2,596 | 6,525 | 10,767 | 10,767 | 741 | 56 | 10,767 | 700 |
| mumbai | 821 | 1,125 | 1,125 | 1,125 | 16,878 | 16,878 | 16,878 | 16,878 | — | 234 | 60 | 11,499 | 1,125 | 553 | 16,878 | 3,546 | 8,740 | 11,369 | 2,029 | 16,878 | 8,090 | 2,119 | 8,136 | 1,103 | 1,125 | 16,475 | 1,125 | 2,755 | 11,372 | 84 | 7,893 | 60 | 60 | 701 | 6,555 | 16,878 | 6,525 | 16,878 | 68 | 9,532 | 1,099 | 704 | 2,645 | 371 | 3,286 | 13,438 | 16,878 | 16,878 | 1,125 | 3,957 | 8,358 | 7,944 | 6,221 | 2,266 | 5,826 | 84 | 16,475 | 1,305 | 8,103 | 71 | 988 | 11,372 | 7,124 | 1,125 | 248 | 11,499 | 4,014 | 11,499 | 16,878 | 16,878 | 11,499 | 4,980 | 3,496 | 6,083 | 16,878 | 16,878 | 7,764 | 76 | 16,878 | 956 |
| bengaluru | 1,368 | 1,368 | 1,368 | 1,368 | 21,442 | 21,442 | 21,442 | 21,442 | 5,284 | 2,883 | 110 | 21,442 | 1,368 | 1,210 | 21,442 | 5,964 | 20,467 | 21,318 | 6,173 | 21,442 | 18,755 | 978 | 18,866 | 6,934 | 1,368 | 21,442 | 1,368 | 3,904 | 21,442 | 110 | 1,439 | 110 | 110 | 1,356 | 899 | 21,442 | 15,028 | 21,442 | 63 | 17,385 | 1,368 | 1,368 | — | 2,127 | 5,394 | 21,442 | 21,442 | 21,442 | 1,368 | 8,268 | 20,049 | 19,456 | 10,310 | 5,007 | 11,064 | 110 | 21,442 | 2,823 | 18,746 | 110 | 1,368 | 21,442 | 18,255 | 1,368 | 70 | 21,318 | 6,715 | 21,318 | 21,442 | 21,442 | 21,318 | 10,808 | 5,926 | 15,038 | 21,442 | 21,442 | 1,634 | 110 | 21,442 | 1,368 |
| hyderabad | 1,080 | 1,080 | 1,080 | 1,080 | 15,870 | 15,870 | 15,870 | 15,870 | — | 158 | 90 | 15,870 | 1,080 | 1,022 | 15,870 | 3,914 | 15,092 | 15,541 | 519 | 15,870 | 14,372 | 555 | 14,412 | 4,066 | 1,080 | 15,870 | 1,080 | 2,688 | 15,870 | 90 | 2,652 | 90 | 90 | 1,058 | 993 | 15,870 | 12,181 | 15,870 | 67 | 7,947 | 1,080 | 1,080 | — | 84 | 3,584 | 15,870 | 15,870 | 15,870 | 1,080 | 4,646 | 14,658 | 14,168 | 8,492 | 2,026 | 8,864 | 90 | 15,870 | 1,685 | 14,366 | 90 | 1,080 | 15,870 | 13,476 | 1,080 | 78 | 15,483 | 4,816 | 15,483 | 15,870 | 15,870 | 15,483 | 4,755 | 4,065 | 10,218 | 15,870 | 15,870 | 1,657 | 90 | 15,870 | 1,080 |
| chennai | 599 | 726 | 726 | 726 | 11,136 | 11,136 | 11,136 | 11,136 | — | 199 | 36 | 9,019 | 726 | 577 | 11,136 | 3,064 | 8,540 | 8,814 | 1,361 | 11,136 | 8,413 | 3,387 | 8,433 | 1,405 | 726 | 10,493 | 726 | 2,492 | 9,003 | 54 | 1,667 | 36 | 36 | 591 | 3,240 | 11,136 | 7,641 | 11,136 | 85 | 5,412 | 688 | 575 | — | 595 | 2,633 | 9,853 | 11,136 | 11,136 | 726 | 3,222 | 8,361 | 8,045 | 6,745 | 1,138 | 6,236 | 54 | 10,493 | 797 | 8,413 | 46 | 670 | 9,003 | 8,036 | 726 | 65 | 8,815 | 3,226 | 8,815 | 11,136 | 11,136 | 8,815 | 4,167 | 3,017 | 6,677 | 11,136 | 11,136 | 4,313 | 47 | 11,136 | 639 |
| delhi | 3,304 | 3,304 | 3,304 | 3,304 | 51,027 | 51,027 | 51,027 | 51,027 | — | 595 | 225 | 51,027 | 3,304 | 2,690 | 51,027 | 9,908 | 42,407 | 50,973 | 6,546 | 51,027 | 36,926 | 9,060 | 37,137 | 27,764 | 3,304 | 47,288 | 3,304 | 5,978 | 51,027 | 225 | 15,412 | 225 | 225 | 3,139 | 1,060 | 51,027 | 28,075 | 51,027 | 121 | 25,354 | 3,304 | 3,304 | — | 418 | 7,343 | 51,027 | 51,027 | 51,027 | 3,304 | 8,444 | 37,198 | 37,091 | 21,066 | 6,638 | 18,572 | 225 | 51,027 | 7,244 | 36,909 | 225 | 3,304 | 51,027 | 31,497 | 3,304 | 1,491 | 50,965 | 8,140 | 50,965 | 51,027 | 51,027 | 50,965 | 11,471 | 7,010 | 25,120 | 51,027 | 51,027 | 4,275 | 225 | 51,027 | 3,300 |
| guna | 100 | 100 | 100 | 100 | 1,444 | 1,444 | 1,444 | 1,444 | — | 1 | 9 | 1,444 | 100 | 71 | 1,444 | 195 | 922 | 1,439 | — | 1,444 | 899 | 10 | 10 | 1,171 | 100 | — | 100 | 23 | 1,346 | 9 | — | 9 | 9 | 89 | 21 | 1,444 | 411 | 1,444 | — | 221 | 100 | 100 | — | — | 108 | 1,444 | 1,444 | 1,444 | 100 | 16 | 833 | 850 | 261 | — | 145 | 9 | 1,444 | 244 | 899 | 9 | 100 | 1,349 | 697 | 100 | 7 | 1,439 | 2 | 1,439 | 1,444 | 1,444 | 1,439 | 77 | 81 | 426 | 1,444 | 1,444 | 89 | 9 | 1,444 | 100 |
| jaipur | 624 | 624 | 624 | 624 | 9,292 | 9,292 | 9,292 | 9,292 | — | 73 | 42 | 9,292 | 624 | 565 | 9,292 | 1,517 | 8,257 | 9,284 | 315 | 9,292 | 8,081 | 19 | 111 | 3,637 | 624 | 9,292 | 624 | 1,300 | 8,962 | 42 | 2,878 | 42 | 42 | 603 | 37 | 9,292 | 6,449 | 9,292 | 26 | 2,179 | 624 | 624 | — | — | 1,739 | 9,292 | 9,292 | 9,292 | 624 | 1,632 | 8,153 | 7,976 | 4,357 | 671 | 4,124 | 42 | 9,292 | 962 | 8,080 | 42 | 624 | 8,963 | 7,548 | 624 | 59 | 9,276 | 1,320 | 9,276 | 9,292 | 9,292 | 9,276 | 2,341 | 2,117 | 5,712 | 9,292 | 9,292 | 83 | 42 | 9,292 | 623 |
| ahmedabad | 504 | 504 | 504 | 504 | 7,176 | 7,176 | 7,176 | 7,176 | — | 74 | 42 | 7,176 | 504 | 464 | 7,176 | 2,654 | 7,059 | 7,173 | 197 | 7,176 | 6,640 | 1,969 | 6,679 | 2,494 | 504 | 7,176 | 504 | 2,337 | 7,176 | 42 | 4,632 | 42 | 42 | 497 | 165 | 7,176 | 5,865 | 7,176 | 45 | 4,083 | 504 | 504 | — | — | 2,353 | 7,176 | 7,176 | 7,176 | 504 | 1,342 | 6,546 | 6,517 | 5,036 | 503 | 4,746 | 42 | 7,176 | 795 | 6,636 | 42 | 504 | 7,176 | 6,367 | 504 | 82 | 7,171 | 2,557 | 7,171 | 7,176 | 7,176 | 7,171 | 2,651 | 3,073 | 5,911 | 7,176 | 7,176 | 496 | 42 | 7,176 | 504 |
| lucknow | 529 | 529 | 529 | 529 | 8,464 | 8,464 | 8,464 | 8,464 | — | 13 | 49 | 8,464 | 529 | 502 | 8,464 | 1,536 | 7,764 | 8,464 | 651 | 8,464 | 7,245 | 1,370 | 7,289 | 3,280 | 529 | 8,464 | 529 | 891 | 8,457 | 49 | 5,041 | 49 | 49 | 519 | 68 | 8,464 | 5,807 | 8,464 | 16 | 5,290 | 529 | 529 | — | — | 1,491 | 8,464 | 8,464 | 8,464 | 529 | 1,575 | 7,471 | 7,459 | 4,179 | 1,506 | 3,863 | 49 | 8,464 | 774 | 7,240 | 49 | 529 | 8,457 | 7,099 | 529 | 754 | 8,463 | 689 | 8,463 | 8,464 | 8,464 | 8,463 | 1,591 | 1,825 | 5,417 | 8,464 | 8,464 | 618 | 49 | 8,464 | 529 |
| kolkata | 480 | 480 | 480 | 480 | 7,268 | 7,268 | 7,268 | 7,268 | — | 181 | 42 | 7,268 | 480 | 478 | 7,268 | 2,620 | 6,920 | 6,945 | 831 | 7,268 | 7,004 | 3,166 | 216 | 723 | 480 | 7,268 | 480 | 1,692 | 7,243 | 42 | 3,324 | 42 | 42 | 478 | 1,054 | 7,268 | 6,068 | 7,268 | 55 | 3,850 | 480 | 480 | — | 481 | 1,708 | 7,268 | 7,268 | 7,268 | 480 | 2,053 | 6,775 | 6,679 | 6,024 | 1,468 | 4,957 | 42 | 7,268 | 404 | 7,003 | 42 | 480 | 7,243 | 6,571 | 480 | 34 | 6,848 | 1,671 | 6,848 | 7,268 | 7,268 | 6,848 | 2,652 | 1,971 | 5,129 | 7,268 | 7,268 | 1,786 | 42 | 7,268 | 480 |

1007 of 1040 city × dataset slots filled.
<!-- coverage:end -->

## Not done yet

- The older traffic, mobility and heat widgets still sample their own grids.
  The profile card covers the same data through the store, so these widgets
  can be retired one at a time.
- Ranks in the profile are computed against all of a dataset's cells, across
  every region, and the first click loads that dataset's whole table once.
  Ranking per region would use `loadCells` with the region's shard keys.
- `CellStore.sql()` loads DuckDB's parquet extension from
  `extensions.duckdb.org` on first use. The deploy must allow that host. The
  app's CSP already does.

## Building-level joins (`js/building-data.js`)

With **Buildings** on, the *Building data* panel colours and/or extrudes every
Overture footprint by any registry field. Each building's centroid encodes to
a 10-char DIGIPIN; its first `level` characters are the dataset cell it sits
in, so the join is a `Map` lookup per building (no spatial index). Per-building
fields (`bldg:height_m`, `bldg:area_m2`, `bldg:floors`) come from the footprint
and baked heights themselves.

- Selection keys are `<dataset>:<field>`; share links carry them as `bc=` (colour)
  and `bh=` (height), and DISHA can set them with
  `[ACTION] colorBuildings color:scores:flood_risk height:bldg:height_m`.
- A data driver switches buildings to the MapLibre twin renderer (works on
  terrain and in both themes). Hover shows the building's DIGIPIN; click lists
  every dataset row covering it.
- "Fit colours to buildings in view" stretches a number ramp to the visible
  range. Cell-level values are shared by every building in the cell, so an
  L6 score paints ~1 km blocks; finer datasets give finer building colouring.
- *Export buildings in view* downloads GeoJSON with identity fields plus
  `<dataset>_<field>` for every catalog dataset.
