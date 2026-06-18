# Building-change & future-growth data

How DigiPin gets a real "where is growth, of what type, in the future" signal —
and how to (re)generate the data. All sources are **no Earth Engine required**.

## What feeds what

| Signal | Source | Pipeline | Consumed by |
|---|---|---|---|
| **Building change 2016–2023** | Google Open Buildings **2.5D Temporal** (4 m, presence/count/height; covers India) | `pipeline/growth/download_temporal_gcs.py` (direct GCS, no GEE) | `realtime-growth.js` → `GrowthScore` BUE + emerging-hotspot; `RealEstateModel` `buildingChangeTrend` |
| **Current footprints** | Google Open Buildings v3 / Microsoft / Overture (far more complete than OSM) | `pipeline/download_google_buildings.py` (+ planned `footprint_grid.py`) | Building Intelligence density/FSI |
| **Future urban expansion** | Global **SSP** urban-land projections (1 km, to 2050/2100) | planned `pipeline/growth/download_ssp_urban.py` | `RealEstateModel` `futureExpansion`; `GrowthScore.futureExpansionAdjust`; map overlay |
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

> Licensing: Open Buildings CC-BY-4.0, Microsoft CDLA-Permissive-2.0, GHSL
> CC-BY-4.0, SSP academic (attribute) — all redistributable with attribution.
