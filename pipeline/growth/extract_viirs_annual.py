"""Extract VIIRS Day/Night-Band annual composites for India as a 9-band COG.

Asset: NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG — monthly stable-light composites.
We average all months per year to get annual night-light intensity.

Bands: one per year 2016..2024.
Resolution: native VIIRS ~500m, downsampled to 100m for the export.

Output: data/growth/viirs_2016-2024.tif
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("pipeline.growth.viirs")

from pipeline._lib.regions import get_default_bbox, get_default_region_name

INDIA_BBOX = get_default_bbox()   # defaults to Indore pilot; see pipeline/_lib/regions.py
YEARS = list(range(2016, 2025))
ASSET_ID = "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"
OUTPUT_PATH = Path(f"data/growth/viirs_2016-2024_{get_default_region_name()}.tif")
SCALE_M = 100


def _init_ee():
    """Same dual-path init as extract_buildings_temporal._init_ee()."""
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
    else:
        ee.Initialize(project=project)


def _build_image():
    import ee
    coll = ee.ImageCollection(ASSET_ID)
    region = ee.Geometry.Rectangle(INDIA_BBOX, "EPSG:4326", False)
    bands = []
    for year in YEARS:
        annual = (coll
                  .filterDate(f"{year}-01-01", f"{year}-12-31")
                  .select("avg_rad")
                  .mean()
                  .rename(f"viirs_{year}"))
        bands.append(annual)
    return ee.Image.cat(bands).clip(region), region


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _init_ee()
    import ee
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    image, region = _build_image()
    log.info("Starting VIIRS export ...")
    task = ee.batch.Export.image.toDrive(
        image=image,
        description="digipin_viirs_2016_2024",
        folder="DigiPin",
        fileNamePrefix="viirs_2016-2024",
        region=region, scale=SCALE_M, maxPixels=1e13,
        fileFormat="GeoTIFF",
        formatOptions={"cloudOptimized": True},
    )
    task.start()
    while task.active():
        log.info("Export status: %s", task.status())
        time.sleep(60)
    final = task.status()
    if final.get("state") != "COMPLETED":
        log.error("Export failed: %s", final)
        sys.exit(1)
    log.info("Done. Move to %s", OUTPUT_PATH)


if __name__ == "__main__":
    main()
