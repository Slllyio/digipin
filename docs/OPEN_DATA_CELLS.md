# Open datasets in the cell store

Thirteen open raster datasets (Earth Engine) and two OpenStreetMap datasets are
baked into the per-DIGIPIN-cell store (`data/cells/`, see
[CELL_STORE.md](CELL_STORE.md)) for all eight scored metros: indore_pilot,
bhopal, pune, mumbai, bengaluru, hyderabad, chennai and delhi. Each is a normal
registry entry, so it shows up under **Layers** (groups *Open Data
(satellite)* and *Open Data (OpenStreetMap)*), in the cell profile card, and as
a DuckDB view for `CellStore.sql()`.

| id | level | fields | source (native resolution) |
|---|---:|---|---|
| `population` | 7 | residents 2020, density, growth 2000→2020, projected 2030 | JRC GHSL GHS-POP R2023A (100 m) |
| `built_up` | 7 | built %, non-residential share, new built 2000→2020, volume, height, degree of urbanisation | GHSL GHS-BUILT-S/V/H (100 m), GHS-SMOD (1 km) |
| `land_cover` | 7 | % tree, shrub, grass, crop, built, bare, water, wetland, mangrove; dominant class | ESA WorldCover 2021 (10 m) |
| `vegetation` | 7 | NDVI annual / dry / post-monsoon, canopy height, tree canopy ≥ 5 m | Sentinel-2 L2A 2025 (10 m), Meta/WRI canopy height (1 m) |
| `terrain` | 7 | elevation, relief, slope, height above nearest drainage | Copernicus DEM GLO-30 2024_1, MERIT Hydro (90 m) |
| `water` | 7 | water occurrence, permanent water, ever water, river-flood depth + extent (1-in-100, 1-in-10 yr) | JRC Global Surface Water 1.4 (30 m), GloFAS flood hazard v2.1 (90 m) |
| `nightlights` | 7 | radiance 2025, change since 2015 | VIIRS DNB monthly VCMSLCFG (~460 m) |
| `surface_heat` | 7 | pre-monsoon LST, anomaly vs city median, MODIS day/night LST | Landsat 8/9 C2 L2 (30 m), MODIS MOD11A2 (1 km) |
| `building_stock` | 7 | buildings 2016 / 2023, new buildings, growth %, roof cover, height | Google Open Buildings 2.5D Temporal (4 m) |
| `soil` | 7 | clay, sand, organic carbon, pH, USDA texture | OpenLandMap v02 (250 m) |
| `air_quality` | 6 | PM2.5 (2022), NO₂, CO, aerosol index, HCHO (2025) | ACAG V6.GL PM2.5 (~1 km), Sentinel-5P OFFL L3 (~5 km) |
| `rainfall` | 6 | 2025 total, monsoon, wettest day, heavy-rain days, 10-yr mean, anomaly | CHIRPS v2 daily (~5 km) |
| `accessibility` | 6 | travel time to health facility, to a city of 50k+ | Malaria Atlas Project friction surfaces (1 km) |
| `osm_amenities` | 7 | POIs in 11 categories (score engine classifier) | OpenStreetMap / Geofabrik |
| `osm_roads` | 7 | road km/km² by class, junctions/km², buildings, footprint cover | OpenStreetMap / Geofabrik |

Kilometre-scale sources go to L6 (~975 m) so a cell never looks sharper than its
data. Every field carries its unit, legend domain, ramp and `higherIs` in the
catalog; descriptions state the caveats (e.g. GloFAS ignores embankments, S5P
columns are not ground concentrations, building counts are a model estimate).

## How the raster bake works

`pipeline/cells/earthengine.py` builds an output grid aligned to DIGIPIN cell
edges, so each output pixel is exactly one cell. Each band is reprojected to
its source's working scale and `reduceResolution` averages every source pixel
inside the cell (a 244 m cell over a 10 m raster is the mean of ~600 pixels),
or takes the `mode` for class rasters. Results come back with
`ee.data.computePixels` as NPY tiles; empty cells are marked with a sentinel and
dropped. Nothing is downloaded as GeoTIFF.

```sh
pip install earthengine-api numpy pyarrow
python -m pipeline.cells.ee_layers --list
python -m pipeline.cells.ee_layers --region delhi                # all layers, one city
python -m pipeline.cells.ee_layers --region all population soil  # some layers, all cities
```

Auth: `GEE_SERVICE_ACCOUNT_KEY` (key JSON), or in a Claude cloud session the
proxy-injected token on earthengine.googleapis.com. `GEE_PROJECT` defaults to
`van-suraksha-alert`. A new layer is one function in `LAYERS` that returns
`(DatasetSpec, CellTable)`.

Sentinel-2 year-long medians are the heaviest step (about 10 min for Indore),
so `vegetation` fetches in 64-pixel tiles to stay under Earth Engine's memory
limit.

## OpenStreetMap layers

`python -m pipeline.cells.osm_layers --region bhopal --pbf bhopal.osm.pbf` does
one pyosmium pass: classified POIs per category, road segment length credited to
the cell of the segment midpoint, junctions (nodes on two or more drivable
ways), and mapped buildings with shoelace footprint area. Without `--pbf` it
downloads the Geofabrik zone extracts and clips each city with `osmium`.

## Refreshing

The **Open data cells** workflow (`.github/workflows/open-data-cells.yml`) runs
monthly and on demand (`sources`: `osm`, `ee` or both; `region`; `layers`) and
commits the result to the branch it runs on. The Earth Engine step needs a
`GEE_SERVICE_ACCOUNT_KEY` repository secret and is skipped with a notice
without one.
