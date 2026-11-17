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
| City | `accessibility` L6 | `aerosol_monthly` L6 | `afternoon_heat` L7 | `air_heat` L6 | `air_measured` L7 | `air_monitors` L7 | `air_quality` L6 | `air_trend` L6 | `ambient_pop` L7 | `anganwadis` L7 | `assembly_results` L7 | `bda_layouts` L7 | `big_projects` L7 | `birds` L6 | `blackouts` L6 | `borewells` L7 | `brick_kilns` L7 | `building_dynamics` L7 | `building_form` L7 | `building_stock` L7 | `built_class` L7 | `built_up` L7 | `builtup_yearly` L7 | `bus_service` L7 | `bus_stop_heat` L7 | `bus_stops_official` L7 | `cadastre` L7 | `canteens` L7 | `census_homes` L7 | `city_climate` L7 | `city_crime` L5 | `city_emissions` L7 | `city_road_deaths` L5 | `city_vitals` L7 | `climate_future` L5 | `climate_twin` L7 | `climate_zones` L7 | `closed_land` L7 | `co_monthly` L6 | `colleges` L7 | `community_halls` L7 | `commute_carbon` L6 | `constituencies` L7 | `construction_monthly` L7 | `crash_zones` L7 | `crossings` L7 | `cycling` L7 | `cyclones` L7 | `demographics` L7 | `deprivation` L7 | `district_dev` L7 | `district_income` L7 | `diwali_air` L7 | `downwind` L7 | `drain_buffers` L7 | `drains` L7 | `droughts` L7 | `earth_bounds` L7 | `eco_limits` L7 | `econ_census` L7 | `elections_2024` L7 | `embeddings` L7 | `emergency_access` L7 | `emission_sources` L7 | `encroachment` L7 | `ev_charging` L7 | `farmland` L7 | `feels_like` L6 | `fire_stations_official` L7 | `fires` L6 | `flight_paths` L7 | `flood_exposure` L7 | `flood_future` L6 | `flood_reports` L7 | `flood_spots` L7 | `flood_zones` L7 | `food_prices` L7 | `fossil_co2` L7 | `freight` L7 | `funeral_sites` L7 | `gated_streets` L7 | `green_change` L7 | `green_rank` L7 | `groundwater_local` L7 | `growth` L7 | `gw_district` L7 | `haze_mix` L5 | `hces` L5 | `heat_change` L7 | `heat_island` L7 | `heritage` L7 | `humid_future` L5 | `humid_heat` L5 | `intercity_trains` L7 | `job_access` L6 | `junction_counts` L7 | `lake_buffers` L7 | `lake_oxygen` L7 | `lake_water` L7 | `lakes` L7 | `land_cover` L7 | `land_efficiency` L7 | `land_value` L7 | `landcover_yearly` L7 | `landmarks` L7 | `landslide_susceptibility` L7 | `landslides` L7 | `landuse` L7 | `landuse_2011` L7 | `landuse_2017` L7 | `level_crossings` L7 | `libraries_official` L7 | `lightning` L6 | `liquefaction` L7 | `low_ground` L7 | `lst_monthly` L6 | `mangroves` L7 | `metro_future` L7 | `metro_service` L7 | `mobility` L7 | `ndvi_monthly` L7 | `neighbourhoods` L7 | `new_roads` L7 | `news_floods` L7 | `nfhs` L7 | `nfhs6` L5 | `night_heat` L7 | `night_shelters` L7 | `nightlights` L7 | `nightlights_monthly` L7 | `no2_monthly` L6 | `osm_amenities` L7 | `osm_roads` L7 | `osm_walk` L7 | `parking` L7 | `parks` L7 | `parks_official` L7 | `pincodes` L7 | `places` L7 | `play_space` L7 | `pm25_days` L7 | `pm25_monthly` L5 | `pm_heat` L7 | `police_official` L7 | `police_stations` L7 | `pop_history` L7 | `population` L7 | `potholes` L7 | `power_lines` L7 | `power_plants` L7 | `premium_brands` L7 | `property_tax` L7 | `public_care` L7 | `public_land` L7 | `pune_prabhag_2016` L7 | `quake_history` L7 | `rail_access` L7 | `railways` L7 | `rain_gauges` L7 | `rain_monthly` L5 | `rainfall` L6 | `re_supply` L7 | `registration` L7 | `road_crashes` L7 | `road_plan` L7 | `road_surface` L7 | `roads_building` L7 | `roll_revision` L7 | `roofs` L7 | `room_rank` L7 | `sar_floods` L7 | `school_safety` L7 | `schools_official` L7 | `schools_udise` L7 | `scores` L6 | `sdg_city` L7 | `service_areas` L7 | `service_centres` L7 | `settlement_2011` L7 | `sewers` L7 | `sites` L7 | `slums_mapped` L7 | `social_ties` L7 | `soil` L7 | `solar_atlas` L7 | `storm_drains` L7 | `stps` L7 | `street_dogs` L7 | `street_form` L7 | `street_grid` L7 | `street_infra` L7 | `street_lights` L7 | `subsidence` L7 | `subsoil` L7 | `sunday_air` L7 | `surface_heat` L7 | `tank_beds` L7 | `tb_care` L7 | `terrain` L7 | `toilets_official` L7 | `tolls` L7 | `topsoil` L7 | `trade_licences` L7 | `traffic` L7 | `traffic_challans` L7 | `traffic_load` L7 | `traffic_noise` L7 | `tree_census` L7 | `tree_felling` L7 | `tree_season` L7 | `underpasses` L7 | `urban_expansion` L7 | `urban_form` L7 | `vegetation` L7 | `village_services` L7 | `villages` L7 | `ward_results` L7 | `wards` L7 | `warm_days` L7 | `waste_bins` L7 | `waste_recovery` L7 | `water` L7 | `water_balance` L7 | `water_bodies` L7 | `water_colour` L7 | `water_history` L7 | `water_lines` L7 | `water_risk` L5 | `water_storage` L7 | `water_store` L7 | `waterlogging` L7 | `watersheds` L7 | `wealth` L6 | `well_quality` L7 | `wind` L7 | `winter_nights` L7 | `work_heat` L7 | `work_orders` L7 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| indore_pilot | 2,209 | 2,209 | 33,489 | 2,209 | — | — | 2,209 | 2,209 | 33,489 | — | — | — | — | — | 1,087 | — | — | 33,489 | 11,548 | 33,489 | 17,283 | 33,489 | 33,489 | — | 86 | — | — | — | — | — | 156 | 33,489 | 156 | — | 156 | 33,489 | 33,489 | 67 | 2,209 | — | — | 1,383 | 33,489 | 33,489 | — | 3,624 | 17,793 | 33,489 | 33,448 | 30,542 | — | — | 33,489 | 33,489 | — | 318 | 33,489 | 33,489 | — | — | 33,489 | 33,489 | 18,104 | 33,489 | 206 | 18,198 | 28,105 | 2,209 | — | 2,209 | 33,423 | 33,489 | 2,209 | — | — | — | 33,489 | 33,489 | 970 | — | 10,494 | 33,460 | 33,489 | — | 30,611 | — | 156 | — | 33,460 | 33,489 | 4 | 156 | 156 | 33,489 | 1,976 | — | — | — | — | 507 | 33,489 | 33,489 | 7,780 | 33,489 | 10 | 33,489 | — | 3,465 | — | — | 41 | — | 2,209 | — | — | 2,209 | — | 610 | — | 1,761 | 33,489 | 33,489 | — | 196 | 33,489 | — | 33,480 | — | 33,489 | 33,489 | 2,209 | 1,575 | 16,996 | 17,202 | 3,292 | 705 | — | — | 3,235 | 33,489 | 33,489 | 156 | 33,481 | — | — | 33,489 | 33,489 | — | 3,624 | 33,489 | 303 | — | — | — | — | 33,489 | 18,098 | 1,930 | — | 156 | 2,209 | 30,658 | — | — | — | 21,811 | 67 | — | 13,677 | 33,489 | — | — | — | — | 2,209 | 33,489 | — | — | 32,467 | — | 132 | — | 33,489 | 33,448 | 33,489 | — | — | — | 14,875 | 8,624 | 1,340 | — | 33,440 | 33,448 | 33,489 | 33,489 | — | — | 33,489 | — | 33,489 | 33,448 | — | 1,990 | — | 2,162 | 10,806 | — | — | 20,505 | 827 | 33,489 | 12,709 | 33,489 | — | — | — | 4,900 | 33,489 | — | — | 33,489 | 33,489 | — | — | 1,389 | — | 156 | — | 33,489 | 33,489 | — | 2,180 | — | 33,489 | 33,480 | 33,489 | — |
| bhopal | 442 | 442 | 6,565 | 442 | — | — | 442 | 442 | 6,565 | — | — | — | — | 225 | 394 | — | — | 6,565 | 4,170 | 6,565 | 4,800 | 6,565 | 6,565 | — | 30 | — | — | — | — | — | — | 6,565 | 35 | — | 35 | 6,565 | 6,565 | 97 | 442 | — | — | 377 | 6,565 | 6,565 | — | 1,156 | 5,488 | 6,565 | 6,218 | 6,198 | — | — | 6,565 | 6,565 | — | 66 | 6,565 | 6,565 | — | — | 6,565 | 6,565 | 4,977 | 6,565 | 257 | 68 | 3,883 | 434 | — | 442 | 6,565 | 6,565 | 442 | — | — | — | 6,565 | 6,565 | 507 | — | 4,435 | 6,325 | 6,565 | — | 6,498 | — | 35 | — | 6,325 | 6,565 | 1,445 | 35 | 35 | 6,565 | 414 | — | — | — | — | 661 | 6,565 | 6,565 | 3,446 | 6,565 | 13 | 6,565 | — | 2,940 | — | — | 18 | — | 442 | — | — | 442 | — | 220 | — | 811 | 6,565 | 6,565 | — | 193 | 6,565 | — | 6,289 | — | 6,565 | 6,565 | 442 | 760 | 5,259 | 5,240 | 2,263 | 254 | — | 6,565 | 1,976 | 6,565 | 6,565 | 35 | 6,287 | — | — | 6,565 | 6,565 | — | 732 | 6,565 | 206 | — | — | — | — | 6,565 | 4,970 | 1,009 | — | 35 | 442 | 6,498 | — | — | — | 6,152 | 13 | — | 4,402 | 6,565 | — | — | — | — | 442 | 6,565 | — | — | 6,533 | — | 27 | — | 6,565 | 6,201 | 6,565 | — | — | — | 4,622 | 3,885 | 603 | — | 6,210 | 6,201 | 6,565 | 6,565 | — | — | 6,565 | — | 6,565 | 6,201 | — | 969 | — | 996 | 3,287 | — | — | 3,739 | 341 | 6,081 | 5,251 | 6,565 | — | — | — | 5,129 | 6,565 | — | — | 6,565 | 6,565 | — | — | 996 | — | 35 | — | 6,565 | 6,565 | — | 442 | — | 6,565 | 6,286 | 6,565 | — |
| pune | 700 | 700 | 10,767 | 700 | 10,767 | — | 700 | 700 | 10,767 | — | 10,767 | — | — | 522 | 697 | — | — | 10,767 | 8,460 | 10,767 | 9,478 | 10,767 | 10,767 | 3,945 | 1,621 | 2,694 | 5,507 | — | — | 10,767 | 56 | 10,767 | 56 | — | 56 | 10,767 | 10,767 | 1,413 | 700 | — | — | 658 | 10,767 | 10,767 | — | 2,680 | 10,155 | 10,767 | 10,733 | 10,678 | 10,767 | 10,767 | 10,767 | 10,767 | — | 438 | 10,767 | 10,767 | — | — | 10,767 | 10,767 | 9,675 | 10,767 | 778 | 9,694 | 4,482 | 700 | 14 | 700 | 10,767 | 10,767 | 700 | — | — | — | — | 10,767 | 1,772 | 65 | 8,473 | 10,738 | 10,767 | — | 10,767 | 10,767 | 56 | 56 | 10,738 | 10,767 | 2,655 | 56 | 56 | 10,767 | 697 | — | — | — | — | 258 | 10,767 | 10,767 | 7,520 | 10,767 | 32 | 10,767 | — | 5,745 | — | — | 20 | 53 | 700 | — | — | 700 | — | 24 | — | 2,472 | 10,767 | 10,767 | — | 450 | 10,767 | 56 | 10,745 | — | 10,767 | 10,767 | 700 | 2,847 | 9,695 | 9,345 | 5,484 | 1,277 | 189 | 10,767 | 5,646 | 10,767 | 10,767 | 56 | 10,748 | — | — | 10,767 | 10,767 | — | 920 | 10,767 | 576 | — | 45 | — | 4,431 | 10,767 | 9,670 | 1,149 | — | 56 | 700 | 10,767 | — | — | — | 10,676 | 53 | — | 8,921 | 10,767 | — | 10,058 | — | 10,061 | 700 | 10,767 | — | — | 10,767 | 7,626 | 82 | — | 10,767 | 10,736 | 10,767 | 7,741 | 16 | — | 8,128 | 7,064 | 3,706 | — | 10,737 | 10,736 | 10,767 | 10,767 | — | — | 10,767 | 311 | 10,767 | 10,736 | — | 3,346 | — | 2,598 | 6,520 | 4,319 | — | 7,165 | 738 | 10,767 | 10,611 | 10,767 | 2,255 | 10,766 | 7,149 | 7,558 | 10,767 | — | — | 10,767 | 10,767 | — | 67 | 741 | — | 56 | — | 10,767 | 10,767 | 10,767 | 700 | — | 10,767 | — | 10,767 | — |
| mumbai | 821 | 1,125 | 16,475 | 796 | 16,475 | — | 1,125 | 1,125 | 12,510 | — | 9,470 | — | — | 668 | 984 | — | — | 16,878 | 7,024 | 16,878 | 7,872 | 16,878 | 16,878 | 3,537 | 2,642 | 2,713 | — | — | 8,140 | 16,475 | 81 | 16,475 | 81 | — | 60 | 16,475 | 11,499 | 925 | 1,125 | — | — | 553 | 9,470 | 16,878 | — | 3,546 | 8,740 | 16,475 | 11,369 | 10,419 | 14,844 | 14,844 | 16,475 | 16,475 | — | 2,029 | 16,475 | 16,475 | — | — | 9,470 | 16,878 | 8,088 | 16,475 | 2,119 | 8,133 | 1,103 | 651 | 35 | 1,125 | 16,475 | 16,475 | 1,125 | — | — | — | 16,475 | 16,475 | 2,755 | 142 | 6,790 | 11,753 | 16,475 | — | 11,372 | 14,844 | 84 | 81 | 11,753 | 16,475 | 7,893 | 60 | 60 | 16,475 | 701 | — | — | — | — | 6,555 | 16,878 | 16,475 | 6,522 | 16,878 | 68 | 12,911 | 17 | 9,532 | — | — | 42 | — | 1,099 | — | 11,566 | 704 | 2,645 | 371 | — | 3,286 | 13,438 | 12,832 | — | 646 | 14,844 | 81 | 11,732 | — | 16,878 | 16,878 | 1,125 | 3,958 | 8,358 | 7,944 | 6,221 | 2,266 | 7,294 | 12,776 | 5,826 | 16,475 | 11,107 | 84 | 11,776 | 7,277 | 7,276 | 16,475 | 16,475 | — | 1,305 | 16,475 | 1,004 | — | — | — | — | 16,475 | 8,101 | 2,950 | — | 71 | 988 | 11,372 | — | — | — | 10,087 | 284 | — | 7,124 | 16,475 | — | 8,196 | 1,113 | 8,199 | 1,125 | 16,475 | — | — | 12,742 | — | 248 | 2,501 | 16,475 | 11,499 | 16,878 | — | — | 8,140 | 6,808 | 5,868 | 4,014 | — | 8,700 | 11,499 | 16,475 | 16,878 | — | — | 16,878 | 2,117 | 16,475 | 11,499 | — | 4,980 | 7,276 | 3,493 | 6,100 | — | — | 10,830 | 1,481 | 11,334 | 15,469 | 16,878 | — | — | — | 9,775 | 16,475 | — | — | 16,878 | 16,475 | — | 330 | 7,764 | — | 76 | — | 16,475 | 16,878 | 10,889 | 956 | — | 16,878 | — | 16,475 | — |
| bengaluru | 1,368 | 1,368 | 21,442 | 1,368 | 21,442 | 31 | 1,368 | 1,368 | 21,442 | 1,429 | 21,442 | 3,184 | 525 | 1,141 | 1,362 | 2,968 | — | 21,442 | 17,688 | 21,442 | 19,212 | 21,442 | 21,442 | 5,284 | 3,335 | — | 10,237 | 153 | — | 21,442 | 110 | 21,442 | 110 | 21,442 | 110 | 21,442 | 21,442 | 1,645 | 1,368 | 930 | — | 1,210 | 21,442 | 21,442 | 21,442 | 5,964 | 20,467 | 21,442 | 21,318 | 21,312 | 21,442 | 21,442 | 21,442 | 21,442 | 8,490 | 6,173 | 21,442 | 21,442 | 67 | — | 21,442 | 21,442 | 18,982 | 21,442 | 978 | 19,070 | 6,934 | 1,368 | 20 | 1,368 | 21,442 | 21,442 | 1,368 | 1,575 | — | — | 21,442 | 21,442 | 3,904 | 65 | 18,150 | 21,429 | 21,442 | 11,199 | 21,442 | 21,442 | 110 | 110 | 21,429 | 21,442 | 1,439 | 110 | 110 | 21,442 | 1,356 | 2,148 | 2,395 | — | 11,300 | 899 | 21,442 | 21,442 | 14,998 | 21,442 | 63 | 21,442 | 2 | 17,385 | 12,664 | 12,668 | 45 | 102 | 1,368 | — | — | 1,368 | — | 2,127 | 101 | 5,397 | 21,442 | 21,442 | 14,029 | 1,049 | 21,442 | 110 | 21,394 | — | 21,442 | 21,442 | 1,368 | 8,285 | 20,050 | 19,456 | 10,314 | 5,007 | — | 21,442 | 11,064 | 21,442 | 21,442 | 110 | 21,392 | 20,772 | 20,772 | 21,442 | 21,442 | 2,931 | 2,823 | 21,442 | 1,278 | — | 353 | 1,445 | — | 21,442 | 18,976 | 3,020 | 136 | 110 | 1,368 | 21,442 | 21,442 | 14,916 | 8,854 | 21,254 | 659 | 21,442 | 18,255 | 21,442 | — | 19,684 | — | 19,635 | 1,368 | 21,442 | 15,998 | 1,267 | 21,106 | 12,457 | 70 | 1,023 | 21,442 | 21,318 | 21,442 | — | 30 | — | 18,137 | 16,605 | 6,715 | 4,598 | 21,218 | 21,318 | 21,442 | 21,442 | — | 28 | 21,442 | — | 21,442 | 21,318 | 20,308 | 10,809 | — | 5,926 | 15,067 | 5,332 | 21,442 | 15,247 | 1,735 | 21,442 | 20,420 | 21,442 | 3,841 | 20,831 | — | 12,368 | 21,442 | — | 51 | 21,442 | 21,442 | 316 | — | 1,634 | 12,615 | 110 | — | 21,442 | 21,442 | 21,441 | 1,368 | 21,442 | 21,442 | — | 21,442 | 12,368 |
| hyderabad | 1,080 | 1,080 | 15,870 | 1,080 | 15,870 | 10 | 1,080 | 1,080 | 15,870 | 1,281 | 15,870 | — | — | 715 | 1,072 | — | — | 15,870 | 13,291 | 15,870 | 14,350 | 15,870 | 15,870 | 3,147 | 1,566 | 3,147 | 2,293 | 128 | — | 15,870 | 90 | 15,870 | 90 | — | 90 | 15,870 | 15,870 | 1,401 | 1,080 | — | 1,100 | 1,022 | 15,870 | 15,870 | — | 3,914 | 15,092 | 15,870 | 15,541 | 15,645 | — | 15,870 | 15,870 | 15,870 | — | 519 | 15,870 | 15,870 | — | — | 15,870 | 15,870 | 14,374 | 15,870 | 555 | 14,412 | 4,066 | 1,074 | 21 | 1,080 | 15,870 | 15,870 | 1,080 | 118 | — | — | 15,870 | 15,870 | 2,688 | — | 13,446 | 15,691 | 15,870 | — | 15,870 | 15,870 | 90 | 90 | 15,691 | 15,870 | 2,652 | 90 | 90 | 15,870 | 1,058 | — | 3,560 | 5,274 | — | 993 | 15,870 | 15,870 | 12,178 | 15,870 | 67 | 15,870 | 3 | 7,947 | — | — | 27 | — | 1,080 | — | — | 1,080 | — | 84 | 57 | 3,584 | 15,870 | 15,870 | — | 1,250 | 15,870 | 90 | 15,687 | — | 15,870 | 15,870 | 1,080 | 4,649 | 14,658 | 14,168 | 8,492 | 2,026 | 1,736 | 15,870 | 8,864 | 15,870 | 15,870 | 90 | 15,673 | 83 | 3,957 | 15,870 | 15,870 | — | 1,685 | 15,870 | 926 | — | 375 | — | — | 15,870 | 14,368 | 1,477 | — | 90 | 1,080 | 15,870 | — | — | — | 15,576 | 32 | — | 13,476 | 15,870 | — | 7,416 | 3,444 | 7,291 | 1,080 | 15,870 | — | — | 15,301 | 2,996 | 78 | 2,572 | 15,870 | 15,483 | 15,870 | — | — | — | 13,210 | 12,237 | 4,816 | — | 15,073 | 15,483 | 15,870 | 15,870 | 2,422 | — | 15,870 | 469 | 15,870 | 15,483 | — | 4,759 | — | 4,068 | 10,218 | — | — | 9,217 | 907 | 15,870 | 15,433 | 15,870 | — | — | 9,973 | 10,060 | 15,870 | 1,306 | — | 15,870 | 15,870 | 320 | — | 1,657 | — | 90 | — | 15,870 | 15,870 | 15,870 | 1,080 | — | 15,870 | — | 15,870 | — |
| chennai | 599 | 726 | 10,493 | 606 | 10,493 | — | 726 | 726 | 9,375 | 745 | 9,018 | — | — | 566 | 649 | — | — | 11,136 | 7,939 | 11,136 | 8,395 | 11,136 | 11,136 | 3,027 | 1,693 | 696 | — | 380 | — | 10,493 | 50 | 10,493 | 50 | 10,493 | 36 | 10,493 | 9,019 | 544 | 726 | — | — | 577 | 9,018 | 11,136 | — | 3,064 | 8,540 | 10,493 | 8,814 | 9,080 | — | 9,047 | 10,493 | 10,493 | — | 1,361 | 10,493 | 10,493 | 725 | — | 9,018 | 11,136 | 8,416 | 10,493 | 3,387 | 8,436 | 1,405 | 552 | — | 726 | 10,493 | 10,493 | 726 | 7,514 | 6,412 | 6,593 | 10,493 | 10,493 | 2,492 | 187 | 7,890 | 8,892 | 10,493 | 6,382 | 9,003 | 9,047 | 54 | 50 | 8,892 | 10,493 | 1,667 | 36 | 36 | 10,493 | 591 | — | — | — | — | 3,240 | 11,136 | 10,493 | 7,639 | 11,136 | 85 | 9,323 | 1 | 5,412 | — | — | 37 | — | 688 | 6,585 | 8,831 | 575 | — | 595 | — | 2,634 | 9,853 | 9,465 | — | 1,443 | 9,047 | 50 | 8,941 | 42 | 11,136 | 11,136 | 726 | 3,223 | 8,361 | 8,045 | 6,746 | 1,138 | — | 9,017 | 6,236 | 10,493 | 8,690 | 54 | 8,937 | — | 6,628 | 10,493 | 10,493 | — | 797 | 10,493 | 713 | 6,412 | 142 | — | — | 10,493 | 8,416 | 2,192 | — | 46 | 670 | 9,003 | 8,973 | — | — | 9,027 | 153 | 9,018 | 8,036 | 10,493 | — | 7,501 | — | 7,407 | 726 | 10,493 | 8,890 | 44 | 9,268 | 6,794 | 65 | 1,186 | 10,493 | 8,815 | 11,136 | 6,755 | 8 | — | 7,647 | 7,218 | 3,226 | — | 8,493 | 8,815 | 10,493 | 11,136 | — | 35 | 11,136 | 513 | 10,493 | 8,815 | — | 4,167 | — | 3,017 | 6,677 | — | — | 6,036 | 851 | 9,615 | 10,312 | 11,136 | — | — | — | 6,509 | 10,493 | 2,933 | 176 | 11,136 | 10,493 | — | 42 | 4,313 | — | 47 | 10,493 | 10,493 | 11,136 | 9,031 | 639 | — | 11,136 | — | 10,493 | — |
| delhi | 3,304 | 3,304 | 51,027 | 3,304 | 51,027 | — | 3,304 | 3,304 | 51,027 | — | 28,360 | — | — | 1,519 | 2,923 | — | 50,090 | 51,027 | 31,555 | 51,027 | 36,335 | 51,027 | 51,027 | — | 595 | — | — | — | — | 51,027 | 225 | 51,027 | 225 | 51,027 | 225 | 51,027 | 51,027 | 2,096 | 3,304 | — | — | 2,690 | 51,027 | 51,027 | 51,027 | 9,908 | 42,407 | 51,027 | 50,973 | 48,653 | — | — | 51,027 | 51,027 | — | 6,546 | 51,027 | 51,027 | — | — | 51,027 | 51,027 | 36,926 | 51,027 | 9,060 | 37,137 | 27,764 | 3,304 | — | 3,304 | 47,288 | 51,027 | 3,304 | — | — | — | 51,027 | 51,027 | 5,978 | — | 31,961 | 51,026 | 51,027 | — | 51,027 | 28,727 | 225 | 225 | 51,026 | 51,027 | 15,412 | 225 | 225 | 51,027 | 3,139 | — | — | — | — | 1,060 | 51,027 | 51,027 | 28,075 | 51,027 | 121 | 51,027 | 4 | 25,354 | — | — | 75 | — | 3,304 | — | — | 3,304 | — | 418 | — | 7,350 | 51,027 | 51,027 | — | 1,378 | 51,027 | — | 51,020 | — | 51,027 | 51,027 | 3,304 | 8,454 | 37,201 | 37,093 | 21,066 | 6,638 | — | 51,027 | 18,572 | 51,027 | 51,027 | 225 | 51,020 | — | — | 51,027 | 51,027 | — | 7,244 | 51,027 | 2,100 | — | — | — | — | 51,027 | 36,909 | 6,102 | — | 225 | 3,304 | 51,027 | — | — | — | 48,496 | 246 | — | 31,497 | 51,027 | 51,027 | 24,851 | — | 24,851 | 3,304 | 51,027 | — | — | 51,027 | — | 1,491 | — | 51,027 | 50,965 | 51,027 | — | — | — | 35,219 | 26,360 | 8,140 | — | 50,978 | 50,965 | 51,027 | 51,027 | — | — | 51,027 | — | 51,027 | 50,965 | — | 11,475 | — | 7,010 | 25,120 | — | — | 31,847 | 3,019 | 51,027 | 41,771 | 51,027 | — | 26,066 | — | 34,035 | 51,027 | — | — | 51,027 | 51,027 | 810 | 111 | 4,275 | — | 225 | — | 51,027 | 51,027 | 51,027 | 3,300 | — | 51,027 | 51,025 | 51,027 | — |
| guna | 100 | 100 | 1,444 | 100 | — | — | 100 | 100 | 1,444 | — | — | — | — | 8 | 63 | — | — | 1,444 | 632 | 1,444 | 846 | 1,444 | 1,444 | — | 1 | — | — | — | — | — | — | 1,444 | — | — | 9 | 1,444 | 1,444 | 10 | 100 | — | — | 71 | 1,444 | 1,444 | — | 195 | 922 | 1,444 | 1,439 | 1,309 | — | — | 1,444 | 1,444 | — | — | 1,444 | 1,444 | — | — | 1,444 | 1,444 | 899 | 1,444 | 10 | 10 | 1,171 | 100 | — | 100 | — | 1,444 | 100 | — | — | — | — | 1,444 | 23 | — | 639 | 1,443 | 1,444 | — | 1,346 | — | 9 | — | 1,443 | 1,444 | — | 9 | 9 | 1,444 | 89 | — | — | — | — | 21 | 1,444 | 1,444 | 411 | 1,444 | — | 1,444 | — | 221 | — | — | 2 | — | 100 | — | — | 100 | — | — | — | 108 | 1,444 | 1,444 | — | 12 | 1,444 | — | 1,444 | — | 1,444 | 1,444 | 100 | 16 | 833 | 850 | 261 | — | — | 1,444 | 145 | — | 1,444 | 9 | 1,444 | — | — | 1,444 | 1,444 | — | 244 | 1,444 | 11 | — | — | — | — | 1,444 | 899 | 120 | — | 9 | 100 | 1,349 | — | — | — | 1,235 | — | — | 697 | 1,444 | — | — | — | — | 100 | 1,444 | — | — | 1,444 | — | 7 | — | 1,444 | 1,439 | 1,444 | — | — | — | 798 | 582 | 2 | — | 1,430 | 1,439 | 1,444 | 1,444 | — | — | 1,444 | — | 1,444 | 1,439 | — | 77 | — | 81 | 426 | — | — | 567 | 86 | 1,444 | 764 | 1,444 | — | — | — | — | 1,444 | — | — | 1,444 | 1,444 | — | — | 89 | — | 9 | — | 1,444 | 1,444 | — | 100 | — | 1,444 | 1,444 | 1,444 | — |
| jaipur | 624 | 624 | 9,292 | 624 | — | — | 624 | 624 | 9,292 | — | — | — | — | 298 | 604 | — | — | 9,292 | 7,419 | 9,292 | 7,967 | 9,292 | 9,292 | — | 73 | — | — | — | — | — | 42 | 9,292 | 42 | — | 42 | 9,292 | 9,292 | 315 | 624 | — | — | 565 | 9,292 | 9,292 | — | 1,517 | 8,257 | 9,292 | 9,284 | 8,902 | — | — | 9,292 | 9,292 | — | 315 | 9,292 | 9,292 | — | — | 9,292 | 9,292 | 8,081 | 9,292 | 19 | 111 | 3,637 | 624 | — | 624 | 9,292 | 9,292 | 624 | — | — | — | 9,292 | 9,292 | 1,300 | — | 7,297 | 9,291 | 9,292 | — | 8,962 | — | 42 | — | 9,291 | 9,292 | 2,878 | 42 | 42 | 9,292 | 603 | — | — | — | — | 37 | 9,292 | 9,292 | 6,449 | 9,292 | 26 | 9,292 | 1 | 2,179 | — | — | 21 | — | 624 | — | — | 624 | — | — | — | 1,740 | 9,292 | 9,292 | — | 189 | 9,292 | — | 9,281 | — | 9,292 | 9,292 | 624 | 1,634 | 8,166 | 7,985 | 4,357 | 671 | — | 9,292 | 4,124 | 9,292 | 9,292 | 42 | 9,282 | — | — | 9,292 | 9,292 | — | 962 | 9,292 | 454 | — | — | — | — | 9,292 | 8,080 | 884 | — | 42 | 624 | 8,963 | — | — | — | 8,669 | 61 | — | 7,548 | 9,292 | — | — | — | — | 624 | 9,292 | — | — | 9,292 | — | 59 | — | 9,292 | 9,276 | 9,292 | — | — | — | 7,545 | 6,892 | 1,320 | — | 9,292 | 9,276 | 9,292 | 9,292 | — | — | 9,292 | — | 9,292 | 9,276 | — | 2,342 | — | 2,117 | 5,712 | — | — | 6,226 | 387 | 9,292 | 8,988 | 9,292 | — | — | — | 6,614 | 9,292 | — | — | 9,292 | 9,292 | — | — | 83 | — | 42 | — | 9,292 | 9,292 | — | 623 | — | 9,292 | 9,282 | 9,292 | — |
| ahmedabad | 504 | 504 | 7,176 | 504 | — | — | 504 | 504 | 7,176 | — | — | — | — | 348 | 500 | — | — | 7,176 | 6,297 | 7,176 | 6,665 | 7,176 | 7,176 | 2,746 | 1,673 | — | — | — | — | 7,176 | 42 | 7,176 | 42 | — | 42 | 7,176 | 7,176 | 239 | 504 | — | — | 464 | 7,176 | 7,176 | — | 2,654 | 7,059 | 7,176 | 7,173 | 7,148 | — | — | 7,176 | 7,176 | — | 197 | 7,176 | 7,176 | — | — | 7,176 | 7,176 | 6,640 | 7,176 | 1,969 | 6,679 | 2,494 | 504 | — | 504 | 7,176 | 7,176 | 504 | — | — | — | 7,176 | 7,176 | 2,337 | — | 6,059 | 7,176 | 7,176 | — | 7,176 | 7,176 | 42 | — | 7,176 | 7,176 | 4,632 | 42 | 42 | 7,176 | 497 | — | — | — | — | 165 | 7,176 | 7,176 | 5,865 | 7,176 | 45 | 7,176 | 1 | 4,083 | — | — | 30 | — | 504 | — | — | 504 | — | — | — | 2,353 | 7,176 | 7,176 | — | 193 | 7,176 | 42 | 7,174 | — | 7,176 | 7,176 | 504 | 1,342 | 6,546 | 6,517 | 5,036 | 503 | — | 7,176 | 4,746 | 7,176 | 7,176 | 42 | 7,176 | — | — | 7,176 | 7,176 | — | 795 | 7,176 | 433 | — | — | — | — | 7,176 | 6,636 | 1,004 | — | 42 | 504 | 7,176 | — | — | — | 7,143 | 44 | — | 6,367 | 7,176 | — | — | — | — | 504 | 7,176 | — | — | 7,176 | — | 82 | — | 7,176 | 7,171 | 7,176 | — | — | — | 6,394 | 5,515 | 2,557 | — | 7,176 | 7,171 | 7,176 | 7,176 | — | — | 7,176 | — | 7,176 | 7,171 | — | 2,651 | — | 3,073 | 5,911 | — | — | 5,712 | 495 | 7,176 | 7,164 | 7,176 | — | 6,733 | — | 6,439 | 7,176 | — | — | 7,176 | 7,176 | — | 76 | 496 | — | 42 | — | 7,176 | 7,176 | — | 504 | — | 7,176 | 7,176 | 7,176 | — |
| lucknow | 529 | 529 | 8,464 | 529 | — | — | 529 | 529 | 8,464 | — | — | — | — | 236 | 520 | — | 8,464 | 8,464 | 6,913 | 8,464 | 7,102 | 8,464 | 8,464 | — | 13 | — | — | — | — | — | 49 | 8,464 | 49 | — | 49 | 8,464 | 8,464 | 647 | 529 | — | — | 502 | 8,464 | 8,464 | — | 1,536 | 7,764 | 8,464 | 8,464 | 8,328 | — | — | 8,464 | 8,464 | — | 651 | 8,464 | 8,464 | — | — | 8,464 | 8,464 | 7,245 | 8,464 | 1,370 | 7,289 | 3,280 | 529 | — | 529 | 8,464 | 8,464 | 529 | — | — | — | 8,464 | 8,464 | 891 | — | 6,857 | 8,464 | 8,464 | — | 8,457 | — | 49 | — | 8,464 | 8,464 | 5,041 | 49 | 49 | 8,464 | 519 | — | — | — | — | 68 | 8,464 | 8,464 | 5,807 | 8,464 | 16 | 8,464 | — | 5,290 | — | — | 62 | — | 529 | — | — | 529 | — | — | — | 1,491 | 8,464 | 8,464 | — | 194 | 8,464 | — | 7,795 | — | 8,464 | 8,464 | 529 | 1,577 | 7,471 | 7,459 | 4,179 | 1,506 | — | 8,464 | 3,863 | 8,464 | 8,464 | 49 | 8,464 | — | — | 8,464 | 8,464 | — | 774 | 8,464 | 417 | — | — | — | — | 8,464 | 7,240 | 1,145 | — | 49 | 529 | 8,457 | — | — | — | 8,252 | 21 | — | 7,099 | 8,464 | — | — | — | — | 529 | 8,464 | — | — | 8,464 | — | 754 | — | 8,464 | 8,463 | 8,464 | — | — | — | 7,377 | 6,427 | 689 | — | 8,464 | 8,463 | 8,464 | 8,464 | — | — | 8,464 | — | 8,464 | 8,463 | — | 1,591 | — | 1,825 | 5,417 | — | — | 7,136 | 473 | 8,464 | 8,098 | 8,464 | — | — | — | 5,125 | 8,464 | — | — | 8,464 | 8,464 | — | 36 | 618 | — | 49 | — | 8,464 | 8,464 | — | 529 | — | 8,464 | 8,464 | 8,464 | — |
| kolkata | 480 | 480 | 7,268 | 480 | 7,268 | — | 480 | 480 | 7,268 | — | 7,268 | — | — | 379 | 480 | — | 7,268 | 7,268 | 6,555 | 7,268 | 6,965 | 7,268 | 7,268 | — | 427 | — | — | — | — | 7,268 | 42 | 7,268 | 42 | — | 42 | 7,268 | 7,268 | 325 | 480 | — | — | 478 | 7,268 | 7,268 | — | 2,620 | 6,920 | 7,268 | 6,945 | 7,228 | — | — | 7,268 | 7,268 | — | 831 | 7,268 | 7,268 | — | 3,236 | 7,268 | 7,268 | 7,008 | 7,268 | 3,166 | 7,017 | 723 | 458 | — | 480 | 7,268 | 7,268 | 480 | — | — | — | 7,268 | 7,268 | 1,692 | — | 6,316 | 7,158 | 7,268 | — | 7,243 | — | 42 | 42 | 7,158 | 7,268 | 3,324 | 42 | 42 | 7,268 | 478 | — | — | — | — | 1,054 | 7,268 | 7,268 | 6,071 | 7,268 | 55 | 7,268 | 1 | 3,850 | — | — | 72 | — | 480 | — | 7,132 | 480 | — | 481 | — | 1,709 | 7,268 | 7,268 | — | 485 | 7,268 | 42 | 7,154 | — | 7,268 | 7,268 | 480 | 2,061 | 6,775 | 6,679 | 6,025 | 1,468 | — | 7,268 | 4,957 | 7,268 | 7,268 | 42 | 7,133 | — | — | 7,268 | 7,268 | — | 404 | 7,268 | 840 | — | — | — | — | 7,268 | 7,007 | 1,789 | — | 42 | 480 | 7,243 | — | — | — | 7,242 | 24 | 7,268 | 6,571 | 7,268 | 7,268 | 3,641 | — | 3,729 | 480 | 7,268 | — | — | 7,220 | — | 34 | — | 7,268 | 6,848 | 7,268 | — | — | — | 6,464 | 5,964 | 1,671 | — | 7,268 | 6,848 | 7,268 | 7,268 | — | — | 7,268 | — | 7,268 | 6,848 | — | 2,652 | — | 1,971 | 5,129 | — | — | 6,456 | 693 | 7,268 | 7,268 | 7,268 | — | 3,186 | — | 3,236 | 7,268 | — | — | 7,268 | 7,268 | 1,141 | 265 | 1,786 | — | 42 | — | 7,268 | 7,268 | 7,268 | 480 | — | 7,268 | 7,166 | 7,268 | — |

2141 of 3094 city × dataset slots filled.
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
