"""Download GHSL GHS-POP 2025 epoch population grid (100m resolution) for India.

GHSL is CC-BY 4.0 from EU JRC. No auth, no GEE needed — direct HTTPS GET.

Source: https://ghsl.jrc.ec.europa.eu/datasets.php?ds=pop
We download the 100m global mosaic and clip to India bbox using rasterio.

Output: data/growth/ghsl_pop_2025.tif
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from urllib.request import urlopen

import rasterio
from rasterio.windows import from_bounds

log = logging.getLogger("pipeline.growth.ghsl")

GHSL_URL = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
    "GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/"
    "GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0.tif"
)
INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
OUTPUT_PATH = Path("data/growth/ghsl_pop_2025.tif")


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    tmp_path = OUTPUT_PATH.with_suffix(".global.tif")
    if not tmp_path.exists():
        log.info("Downloading GHSL global mosaic (~500 MB, may take 5-10 min) ...")
        with urlopen(GHSL_URL) as resp, tmp_path.open("wb") as f:
            shutil.copyfileobj(resp, f)
    else:
        log.info("Reusing cached global mosaic at %s", tmp_path)

    log.info("Clipping to India bbox %s ...", INDIA_BBOX)
    with rasterio.open(tmp_path) as src:
        window = from_bounds(*INDIA_BBOX, transform=src.transform)
        data = src.read(window=window)
        transform = src.window_transform(window)
        profile = src.profile.copy()
        profile.update({
            "height": data.shape[1],
            "width": data.shape[2],
            "transform": transform,
            "compress": "deflate",
            "tiled": True,
        })
        with rasterio.open(OUTPUT_PATH, "w", **profile) as dst:
            dst.write(data)

    log.info("Wrote %s (%.1f MB)", OUTPUT_PATH, OUTPUT_PATH.stat().st_size / 1e6)


if __name__ == "__main__":
    main()
