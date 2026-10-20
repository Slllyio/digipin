# Building-change & future-growth data

How DigiPin gets a real "where is growth, of what type, in the future" signal —
and how to (re)generate the data. All sources are **no Earth Engine required**.

## What feeds what

| Signal | Source | Pipeline | Consumed by |
|---|---|---|---|
| **Building change 2016–2023** | Google Open Buildings **2.5D Temporal** (4 m, presence/count/height; covers India) | `pipeline/growth/download_temporal_gcs.py` (direct GCS, no GEE) | `realtime-growth.js` → `GrowthScore` BUE + emerging-hotspot; `RealEstateModel` `buildingChangeTrend` |
| **Current footprints** | Google Open Buildings v3 / Microsoft / Overture (far more complete than OSM) | `pipeline/download_google_buildings.py` (+ planned `footprint_grid.py`) | Building Intelligence density/FSI |
| **Future urban expansion** | Global **SSP** urban-land projections (1 km, to 2050/2100) | planned `pipeline/growth/download_ssp_urban.py` | `RealEstateModel` `futureExpansion`; `GrowthScore.futureExpansionAdjust`; map overlay |
| **Growth prediction (CA-ML)** | Trained **in-house** on the temporal series + drivers (slope/roads/water/built/pop/lights) — a CA-RF model, hindcast-validated | `pipeline/growth/urban_ca_ml.py` (+ `ca_drivers.py`) | `realtime-growth.js` → `ca_growth_prob`; `RealEstateModel` `caGrowthPrediction`; **`CAGrowthOverlay`** (separate "Predict" layer) — see `docs/CA_GROWTH_MODEL.md` |
| Population Δ | GHSL (JRC), direct download | `pipeline/growth/download_ghsl_pop.py` | `GrowthScore` DEN |

OSMBuildings/OSMBuildings is a 3D *renderer* (unmaintained) — not used; the app
already extrudes Overture/Google footprints.

## Activate the Growth Forecast (no GEE)

```sh
pip install s2sphere rasterio numpy
python -m pipeline.growth.download_temporal_gcs --probe     # verify tile selection
python -m pipeline.growth.download_temporal_gcs --res 100   # build the COG
```

Produces `data/growth/buildings_temporal_2016-2023_<region>.tif` (8 bands, one
per year 2016–2023, value = building presence 0..1). `realtime-growth.js` reads
it client-side and the dormant Growth Forecast + emerging-hotspot + the
`buildingChangeTrend` real-estate factor light up automatically.

**Access chain (verified against the live bucket):** bbox → S2 **level-2**
covering tokens → per-year manifests `v1/manifests/{token}_EPSG_{epsg}_{year}_06_30.json`
→ tileset sources (`uri`, `affineTransform`, `dimensions`) → keep tiles
intersecting the bbox → read the `building_presence` band (3rd) → reproject/
average onto the target grid. For the Indore pilot bbox this selects **29 tiles
per year** across S2 tokens `39`/`3b`.

**Why ~100 m, not native 4 m:** the source tiles are 0.5 m, 25000×25000 px — a
full-res Indore COG would be multiple GB and un-fetchable in a browser.
`realtime-growth.js` loads the whole COG via georaster, so we downsample to a
coarse grid (~1–2 MB) — ample for a neighbourhood growth read. Run it where the
large tile reads are feasible (the `--probe` step is light and runs anywhere);
commit the small resulting COG.

## Future urban-expansion layer (SSP)

```sh
python -m pipeline.growth.download_ssp_urban --url <ssp_scenario_year.tif>   # or --in local.tif
```
Clips a global SSP urban-land projection to `data/growth/ssp_urban_expansion_<region>.tif`
(single band, urban fraction 0..1). `realtime-growth.js` reads it →
`GrowthScore.futureExpansionAdjust` nudges the 5-yr horizon, and the
`futureExpansion` real-estate factor activates. Canonical host
(geosimulation.cn) plus figshare/PANGAEA mirrors; pass the scenario/year GeoTIFF
via `--url`.

## Growth prediction layer (CA-ML)

The SSP layer is coarse (1 km, scenario-driven). For a **sharper, locally-trained**
projection, DigiPin ships a Cellular-Automata + Random-Forest model that learns the
**observed 2016→2023 transitions** and simulates forward:

```sh
pip install -r pipeline/growth/requirements.txt   # adds scikit-learn, scipy
# prerequisites: the temporal COG + driver sources (DEM, OSM roads/water, GHSL, VIIRS)
python -m pipeline.growth.urban_ca_ml --horizon 2035
```

Produces `data/growth/ca_urban_prediction_<region>.tif` (1 band, P(urban by horizon)
0..1, ~100 m) and `data/growth/ca_validation_<region>.json` (hindcast **Figure of
Merit + Cohen's Kappa**). `realtime-growth.js` reads it → `ca_growth_prob`, the
`caGrowthPrediction` real-estate factor activates, and the **Predict** toolbar
button (`CAGrowthOverlay`) renders it as a separate purple layer alongside SSP. Full
method, drivers and accuracy caveats: **`docs/CA_GROWTH_MODEL.md`**.

## Richer footprints grid (fixes OSM undercount)

```sh
python -m pipeline.download_google_buildings           # footprints parquet (no GEE)
python -m pipeline.buildings.footprint_grid --in data/vectors/google_open_buildings_<region>.parquet
```
Aggregates complete ML footprints (Google v3 default; Microsoft/Overture also
supported) into `data/buildings/footprint_grid_<region>.json` — a small per-cell
count / coverage% / mean-area grid the browser samples to correct the OSM-biased
density/FSI in Building Intelligence.

> Licensing: Open Buildings CC-BY-4.0, Microsoft CDLA-Permissive-2.0, GHSL
> CC-BY-4.0, SSP academic (attribute) — all redistributable with attribution.
