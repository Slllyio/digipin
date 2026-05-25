"""Extract Open Buildings Temporal V1 for India as an 8-band COG.

Bands: one per year 2016..2023, value = building_presence (0..1, fractional).
Resolution: 4m (matches DigiPin cell size).

Auth: requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service
account JSON with Earth Engine API access.

Output: data/growth/buildings_temporal_2016-2023.tif
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("pipeline.growth.buildings")

# India bounding box (west, south, east, north) — tight around India main + NE
INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
YEARS = list(range(2016, 2024))   # 8 inclusive years
ASSET_ID = "GOOGLE/Research/open-buildings-temporal/v1"
OUTPUT_PATH = Path("data/growth/buildings_temporal_2016-2023.tif")
SCALE_M = 4   # GEE export scale; matches DigiPin grain


def _init_ee():
    """Initialise Earth Engine — service account in CI, cached OAuth in dev.

    Phase 0a confirmed (2026-05-24) that:
      - OAuth credentials cached at ~/.config/earthengine/credentials work
      - The GCP project must be passed explicitly via the `project` kwarg
        (defaults like `delta-guild-367407` aren't EE-registered and error
        with 'Project X is not registered to use Earth Engine')
    """
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred_path and Path(cred_path).is_file():
        credentials = ee.ServiceAccountCredentials(None, cred_path)
        ee.Initialize(credentials, project=project)
        log.info("Earth Engine initialised via service account, project=%s", project)
        return
    # Fall back to cached OAuth credentials (from `earthengine authenticate`)
    ee.Initialize(project=project)
    log.info("Earth Engine initialised via cached OAuth, project=%s", project)


def _build_image():
    """Combine 8 years of building_presence into one 8-band image."""
    import ee
    collection = ee.ImageCollection(ASSET_ID)
    region = ee.Geometry.Rectangle(INDIA_BBOX, "EPSG:4326", False)

    images = []
    for year in YEARS:
        annual = (collection
                  .filterDate(f"{year}-01-01", f"{year}-12-31")
                  .select("building_presence")
                  .mean()
                  .rename(f"presence_{year}"))
        images.append(annual)
    stacked = ee.Image.cat(images).clip(region)
    return stacked, region


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _init_ee()
    import ee

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    stacked, region = _build_image()

    log.info("Starting EE export of 8-band buildings_temporal COG to %s ...", OUTPUT_PATH)
    log.info("This will run as a Drive export task; manual download afterwards. See README.")

    task = ee.batch.Export.image.toDrive(
        image=stacked,
        description="digipin_buildings_temporal_2016_2023",
        folder="DigiPin",
        fileNamePrefix="buildings_temporal_2016-2023",
        region=region,
        scale=SCALE_M,
        maxPixels=1e13,
        fileFormat="GeoTIFF",
        formatOptions={"cloudOptimized": True},
    )
    task.start()

    # Poll until done (long — 20-60 min for India bbox at 4m scale)
    while task.active():
        log.info("Export status: %s", task.status())
        time.sleep(60)
    final = task.status()
    log.info("Export finished: %s", final)
    if final.get("state") != "COMPLETED":
        log.error("Export did not complete cleanly: %s", final)
        sys.exit(1)

    log.info("Done. Download from Google Drive folder 'DigiPin' and move to %s", OUTPUT_PATH)


if __name__ == "__main__":
    main()
