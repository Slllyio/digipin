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
| City | `accessibility` L6 | `aerosol_monthly` L6 | `air_quality` L6 | `built_up` L7 | `builtup_yearly` L7 | `co_monthly` L6 | `growth` L7 | `land_cover` L7 | `landcover_yearly` L7 | `lst_monthly` L6 | `mobility` L7 | `ndvi_monthly` L7 | `nightlights` L7 | `nightlights_monthly` L7 | `no2_monthly` L6 | `pm25_monthly` L5 | `population` L7 | `rain_monthly` L5 | `rainfall` L6 | `scores` L6 | `soil` L7 | `surface_heat` L7 | `terrain` L7 | `traffic` L7 | `vegetation` L7 | `water` L7 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| indore_pilot | 2,209 | 2,209 | 2,209 | 33,489 | 33,489 | 2,209 | 30,611 | 33,489 | 33,489 | 2,209 | 1,761 | 33,489 | 33,489 | 33,489 | 2,209 | 156 | 33,489 | 156 | 2,209 | 2,209 | 33,448 | 33,489 | 33,489 | 1,990 | 33,489 | 33,489 |
| bhopal | 442 | 442 | 442 | 6,565 | 6,565 | 442 | 6,498 | 6,565 | 6,565 | 442 | — | 6,565 | 6,565 | 6,565 | 442 | 35 | 6,565 | 35 | 442 | 442 | 6,201 | 6,565 | 6,565 | — | 6,565 | 6,565 |
| pune | 700 | 700 | 700 | 10,767 | 10,767 | 700 | 10,767 | 10,767 | 10,767 | 700 | 2,470 | 10,767 | 10,767 | 10,767 | 700 | 56 | 10,767 | 56 | 700 | 700 | 10,736 | 10,767 | 10,767 | 3,342 | 10,767 | 10,767 |
| mumbai | 821 | 1,125 | 1,125 | 16,878 | 16,878 | 1,125 | 11,372 | 16,878 | 16,878 | 704 | 3,289 | 13,438 | 16,878 | 16,878 | 1,125 | 84 | 16,475 | 71 | 988 | 1,125 | 11,499 | 16,878 | 16,878 | 4,984 | 16,878 | 16,878 |
| bengaluru | 1,368 | 1,368 | 1,368 | 21,442 | 21,442 | 1,368 | 21,442 | 21,442 | 21,442 | 1,368 | 5,518 | 21,442 | 21,442 | 21,442 | 1,368 | 110 | 21,442 | 110 | 1,368 | 1,368 | 21,318 | 21,442 | 21,442 | 10,856 | 21,442 | 21,442 |
| hyderabad | 1,080 | 1,080 | 1,080 | 15,870 | 15,870 | 1,080 | 15,870 | 15,870 | 15,870 | 1,080 | 3,576 | 15,870 | 15,870 | 15,870 | 1,080 | 90 | 15,870 | 90 | 1,080 | 1,080 | 15,483 | 15,870 | 15,870 | 4,754 | 15,870 | 15,870 |
| chennai | 599 | 726 | 726 | 11,136 | 11,136 | 726 | 9,003 | 11,136 | 11,136 | 575 | 2,638 | 9,853 | 11,136 | 11,136 | 726 | 54 | 10,493 | 46 | 670 | 726 | 8,815 | 11,136 | 11,136 | 4,165 | 11,136 | 11,136 |
| delhi | 3,304 | 3,304 | 3,304 | 51,027 | 51,027 | 3,304 | 51,027 | 51,027 | 51,027 | 3,304 | 8,011 | 51,027 | 51,027 | 51,027 | 3,304 | 225 | 51,027 | 225 | 3,304 | 3,304 | 50,965 | 51,027 | 51,027 | 11,881 | 51,027 | 51,027 |
| guna | 100 | 100 | 100 | 1,444 | 1,444 | 100 | 1,346 | 1,444 | 1,444 | 100 | 108 | 1,444 | 1,444 | 1,444 | 100 | 9 | 1,444 | 9 | 100 | 100 | 1,439 | 1,444 | 1,444 | 77 | 1,444 | 1,444 |
| jaipur | 624 | 624 | 624 | 9,292 | 9,292 | 624 | 8,962 | 9,292 | 9,292 | 624 | 1,735 | 9,292 | 9,292 | 9,292 | 624 | 42 | 9,292 | 42 | 624 | 624 | 9,276 | 9,292 | 9,292 | 2,338 | 9,292 | 9,292 |
| ahmedabad | 504 | 504 | 504 | 7,176 | 7,176 | 504 | 7,176 | 7,176 | 7,176 | 504 | 2,357 | 7,176 | 7,176 | 7,176 | 504 | 42 | 7,176 | 42 | 504 | 504 | 7,171 | 7,176 | 7,176 | 2,653 | — | 7,176 |
| lucknow | 529 | 529 | 529 | 8,464 | 8,464 | 529 | 8,457 | 8,464 | 8,464 | 529 | 1,491 | 8,464 | 8,464 | 8,464 | 529 | 49 | 8,464 | 49 | 529 | 529 | 8,463 | 8,464 | 8,464 | 1,591 | 8,464 | 8,464 |
| kolkata | 480 | 480 | 480 | 7,268 | 7,268 | 480 | 7,243 | 7,268 | 7,268 | 480 | 1,709 | 7,268 | 7,268 | 7,268 | 480 | 42 | 7,268 | 42 | 480 | 480 | 6,848 | 7,268 | 7,268 | 2,643 | 7,268 | 7,268 |

335 of 338 city × dataset slots filled.
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
