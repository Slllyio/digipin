"""Export MODIS Land Surface Temperature (LST) annual composites for India.

Asset: MODIS/061/MOD11A1 — daily 1km LST product from the Terra satellite.
We average all daily LST observations per year for both day and night
passes, producing one band per (year × phase). Output 18 bands total
(9 years × {Day, Night}) packed into a single multi-band COG.

Why day AND night separately:
  - Day LST captures surface heating from sunlight + low albedo
  - Night LST captures heat retention — the canonical Urban Heat Island
    signal. Cities cool ~3-5°C less than surrounding rural areas at night
    because concrete + asphalt store heat through the day and release
    slowly. Visible mainly in the night band; day band shows a smaller
    but still real effect.
  - Both bands let downstream consumers compute either absolute LST or
    diurnal-range anomalies per cell.

MODIS stores LST as uint16 in Kelvin × 50 (so a stored value of 14400
means 14400/50 = 288 K = 15 °C). The export preserves the raw scaling;
the browser converts at read time.

Output: data/heat/modis_lst_2016-2024.tif (~30 MB at 1km over India bbox)
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path

log = logging.getLogger("pipeline.heat.modis_lst")

from pipeline._lib.regions import get_default_bbox, get_default_region_name

INDIA_BBOX = get_default_bbox()   # defaults to Indore pilot; see pipeline/_lib/regions.py
YEARS = list(range(2016, 2025))     # 9 years, matches VIIRS coverage
ASSET_ID = "MODIS/061/MOD11A1"
OUTPUT_PATH = Path(f"data/heat/modis_lst_2016-2024_{get_default_region_name()}.tif")
SCALE_M = 1000   # MODIS LST native resolution


def _init_ee():
    """Dual-path auth: service account JSON if env var set, else cached OAuth.
    Project defaults to van-suraksha-alert; override via GEE_PROJECT env var."""
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
    else:
        ee.Initialize(project=project)


def _build_image():
    """Multi-band image with bands: lst_day_<year> + lst_night_<year> for each year."""
    import ee
    coll = ee.ImageCollection(ASSET_ID)
    region = ee.Geometry.Rectangle(INDIA_BBOX, "EPSG:4326", False)

    bands = []
    for year in YEARS:
        annual = coll.filterDate(f"{year}-01-01", f"{year}-12-31")
        day = annual.select("LST_Day_1km").mean().rename(f"lst_day_{year}")
        night = annual.select("LST_Night_1km").mean().rename(f"lst_night_{year}")
        bands.extend([day, night])

    return ee.Image.cat(bands).clip(region), region


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _init_ee()
    import ee

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    image, region = _build_image()
    log.info("Starting MODIS LST export (18 bands: day+night x %d years) ...", len(YEARS))
    task = ee.batch.Export.image.toDrive(
        image=image,
        description="digipin_modis_lst_2016_2024",
        folder="DigiPin",
        fileNamePrefix="modis_lst_2016-2024",
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
