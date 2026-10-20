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
| 4 | ~15.6 km | ~9 | district |
| 5 | ~3.9 km | ~144 | city zones |
| 6 | **~975 m** | 2,209 | city-wide scores (`scores`) |
| 7 | **~244 m** | 33,489 | road / grid datasets (`traffic`, `mobility`) |
| 8 | ~61 m | ~532k | point data, block level |
| 10 | ~3.8 m | — | a full DIGIPIN address |

> Older docs (`PRECOMPUTE_PHASE1.md`, `pipeline/_lib/grid.py`) give "level 6 ≈
> 244 m". The grid maths (36° ÷ 4^level) and the enumerated cells say L6 is
> about 975 m and L7 about 244 m. This table uses the measured values.

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

## Frontend API

```js
await CellStore.init();                         // loads catalog.json (silent no-op on 404)
CellStore.datasets();                           // registry entries (catalog + runtime)
await CellStore.rowAt('traffic', lat, lng);     // { digipin, congestion_risk, … } | null
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

## Not done yet

- Cell-panel widgets still sample the old grids. Moving them to
  `CellStore.rowAt` would let one lookup show every dataset for the clicked
  cell.
- Large datasets (L8 city-wide is about 500k cells) need per-prefix sharding of
  the JSON, as `data/scores/` already does, or PMTiles. The catalog's
  `regions[]` can describe shards without a schema change.
- `CellStore.sql()` loads DuckDB's parquet extension from
  `extensions.duckdb.org` on first use. The deploy must allow that host. The
  app's CSP already does.
