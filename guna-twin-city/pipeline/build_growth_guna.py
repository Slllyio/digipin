"""Build the CA-ML urban-growth prediction COG for Guna end-to-end.

The repo's growth pipeline (pipeline/growth/) targets the *national* India
raster and exports each GEE layer to Google Drive (async batch). Guna is one
small city, so this orchestrator fetches every GEE input synchronously via
getDownloadURL (no Drive round-trip), stages the local drivers, then runs the
existing, hindcast-validated CA-RF model (pipeline.growth.urban_ca_ml) unchanged.

Stages:
  1. buildings_temporal_2016-2023_guna.tif  (8 bands, building_presence, GEE)  <- CA target + grid
  2. viirs_2016-2024_guna.tif               (9 bands, avg_rad night-lights, GEE)
  3. ghsl_pop_2020_guna.tif                 (1 band, GHSL population, GEE)
  4. dem_guna.tif                           (copied from the local SRTM)
  5. osm_roads/water_guna.geojson           (copied to data/vectors/ where ca_drivers looks)
  6. urban_ca_ml.run(region='guna')         -> data/growth/ca_urban_prediction_guna.tif (+ validation json)
  7. copy the prediction to guna-twin-city/data/growth/ca_urban_prediction.tif (frontend path)

Run:  python guna-twin-city/pipeline/build_growth_guna.py
"""
from __future__ import annotations

import io
import logging
import os
import shutil
import sys
import zipfile
from pathlib import Path

# ca_drivers / urban_ca_ml resolve inputs by the active region name + bbox.
os.environ.setdefault("DIGIPIN_REGION", "guna")
# Make the repo root importable so `pipeline.growth.*` resolves when run directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

log = logging.getLogger("guna.growth")

REPO = Path(__file__).resolve().parents[2]            # E:/DigiPin
GUNA = Path(__file__).resolve().parents[1]            # guna-twin-city/
GUNA_BBOX = (77.25, 24.58, 77.40, 24.70)              # matches pipeline/_lib/regions.py
GROWTH = REPO / "data" / "growth"
VECTORS = REPO / "data" / "vectors"


def _init_ee():
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
    else:
        ee.Initialize(project=project)
    return ee


def _download(ee, image, region, scale, out_path):
    """Synchronous direct download of a (multi-band) image to a GeoTIFF on disk."""
    import requests
    url = image.getDownloadURL({
        "region": region, "scale": scale, "crs": "EPSG:4326",
        "format": "GEO_TIFF", "maxPixels": 1e9,
    })
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    blob = resp.content
    if blob[:2] == b"PK":                              # zip-wrapped multiband
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            name = next(n for n in zf.namelist() if n.lower().endswith(".tif"))
            blob = zf.read(name)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(blob)
    log.info("wrote %s (%d KB)", out_path.name, len(blob) // 1024)


def fetch_gee_inputs(ee):
    region = ee.Geometry.Rectangle(list(GUNA_BBOX), "EPSG:4326", False)

    # 1. Open Buildings Temporal V1 — building_presence annual means 2016-2023.
    #    Native 4 m; resampled to 30 m here so the whole-city grid fits one request.
    bt = ee.ImageCollection("GOOGLE/Research/open-buildings-temporal/v1")
    bt_bands = [bt.filterDate(f"{y}-01-01", f"{y}-12-31").select("building_presence")
                  .mean().rename(f"presence_{y}") for y in range(2016, 2024)]
    _download(ee, ee.Image.cat(bt_bands).clip(region), region, 30,
              GROWTH / "buildings_temporal_2016-2023_guna.tif")

    # 2. VIIRS DNB monthly avg_rad — annual means 2016-2024 (9 bands).
    vc = ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG")
    v_bands = [vc.filterDate(f"{y}-01-01", f"{y}-12-31").select("avg_rad")
                 .mean().rename(f"viirs_{y}") for y in range(2016, 2025)]
    _download(ee, ee.Image.cat(v_bands).clip(region), region, 100,
              GROWTH / "viirs_2016-2024_guna.tif")

    # 3. GHSL population 2020 (single band).
    ghsl = ee.Image("JRC/GHSL/P2023A/GHS_POP/2020").rename("pop_2020").clip(region)
    _download(ee, ghsl, region, 100, GROWTH / "ghsl_pop_2020_guna.tif")


def _clean_geotiff(src_path, dst_path):
    """Copy a GEE getDownloadURL tif to dst as a clean float32 GeoTIFF.

    GEE direct downloads set TIFF ExtraSamples/Photometric tags in a way the
    browser's geotiff.js misparses (the parsed georaster loses its geo accessors).
    A rasterio round-trip normalises the tags; float32 matches the canonical COG
    the frontend was built against."""
    import rasterio
    with rasterio.open(src_path) as s:
        data = s.read().astype("float32")
        profile = s.profile.copy()
        descs = s.descriptions
    profile.update(driver="GTiff", dtype="float32", tiled=True, blockxsize=256,
                   blockysize=256, compress="deflate")
    profile.pop("photometric", None)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(dst_path, "w", **profile) as d:
        d.write(data)
        for i, desc in enumerate(descs, start=1):
            if desc:
                d.set_band_description(i, desc)


def publish_to_frontend():
    """Place every COG RealtimeGrowth reads under guna-twin-city/data/growth/ with
    the exact frontend filenames (see js/realtime-growth.js COG_* constants)."""
    out = GUNA / "data" / "growth"
    # GEE-downloaded inputs need the clean rewrite; names map to the frontend consts.
    _clean_geotiff(GROWTH / "buildings_temporal_2016-2023_guna.tif",
                   out / "buildings_temporal_2016-2023.tif")
    _clean_geotiff(GROWTH / "viirs_2016-2024_guna.tif", out / "viirs_2016-2024.tif")
    # Frontend expects ghsl_pop_2025.tif; GEE's latest published epoch is 2020.
    _clean_geotiff(GROWTH / "ghsl_pop_2020_guna.tif", out / "ghsl_pop_2025.tif")
    # The CA prediction is already rasterio-clean (written by urban_ca_ml).
    shutil.copyfile(GROWTH / "ca_urban_prediction_guna.tif", out / "ca_urban_prediction.tif")
    log.info("published 4 growth COGs to %s", out)


def stage_local_drivers():
    """Put the DEM + OSM road/water layers where ca_drivers.build_stack looks."""
    GROWTH.mkdir(parents=True, exist_ok=True)
    VECTORS.mkdir(parents=True, exist_ok=True)
    srtm = GUNA / "data" / "rasters" / "srtm_90m_guna.tif"
    if srtm.exists():
        shutil.copyfile(srtm, GROWTH / "dem_guna.tif")
        log.info("staged dem_guna.tif from %s", srtm.name)
    for name in ("osm_roads_guna.geojson", "osm_water_guna.geojson"):
        src = GUNA / "data" / "vectors" / name
        if src.exists():
            shutil.copyfile(src, VECTORS / name)
            log.info("staged %s", name)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    ee = _init_ee()
    fetch_gee_inputs(ee)
    stage_local_drivers()

    from pipeline.growth import urban_ca_ml
    metrics = urban_ca_ml.run(region="guna", horizon=2035)
    log.info("CA-ML done: FoM=%.3f Kappa=%.3f", metrics["figure_of_merit"], metrics["kappa"])

    publish_to_frontend()


if __name__ == "__main__":
    main()
