"""Export GHSL GHS-POP 2020 epoch population grid (100m) for India via GEE.

GHSL (Global Human Settlement Layer) is published by EU JRC as CC-BY 4.0
and mirrored on Google Earth Engine at `JRC/GHSL/P2023A/GHS_POP/<YEAR>`.

Why GEE rather than the direct EU JRC HTTPS endpoint:
  - The original spec referenced jeodpp.jrc.ec.europa.eu/ftp/.../GHS_POP_E2025...
    but that URL moved to the human-settlement.emergency.copernicus.eu
    download wizard in the R2025A release — the new path is dynamic and
    not stable for scripting.
  - GEE auth already verified in Phase 0a (cached OAuth +
    project='van-suraksha-alert'). Reusing > re-inventing a direct download.

Why epoch 2020 (not 2025 as the spec originally said):
  GHSL on GEE goes 1975-2020 in 5-year intervals. The 2025 projection
  released by EU JRC in late 2025 is not yet on GEE. We use 2020 — the
  most recent available — which is sufficient for the DEN sub-score
  (5-year change 2015 -> 2020). When 2025 lands on GEE, change YEAR
  below and re-run.

Output: data/growth/ghsl_pop_2020.tif (single-band COG, ~30 MB at 100m)
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("pipeline.growth.ghsl")

INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
YEAR = 2020   # latest GHSL epoch on GEE as of 2026-05; bump to 2025 once published
ASSET_ID_PREFIX = "JRC/GHSL/P2023A/GHS_POP"
OUTPUT_PATH = Path("data/growth/ghsl_pop_2020.tif")
SCALE_M = 100   # GHSL native resolution


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
    region = ee.Geometry.Rectangle(INDIA_BBOX, "EPSG:4326", False)
    image = ee.Image(f"{ASSET_ID_PREFIX}/{YEAR}").rename(f"pop_{YEAR}").clip(region)
    return image, region


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _init_ee()
    import ee

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    image, region = _build_image()
    log.info("Starting GHSL %d epoch export ...", YEAR)
    task = ee.batch.Export.image.toDrive(
        image=image,
        description=f"digipin_ghsl_pop_{YEAR}",
        folder="DigiPin",
        fileNamePrefix=f"ghsl_pop_{YEAR}",
        region=region,
        scale=SCALE_M,
        maxPixels=1e13,
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
    log.info("Done. Download from Google Drive folder 'DigiPin' and move to %s", OUTPUT_PATH)


if __name__ == "__main__":
    main()
