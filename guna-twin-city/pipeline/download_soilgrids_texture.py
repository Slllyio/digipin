"""ISRIC SoilGrids 250m soil texture (sand / silt / clay) for Guna via WCS.

Needed to derive Hydrologic Soil Group (HSG) per cell for the flood Curve
Number engine (analysis/hsg.py). Extends the SoilGrids pH downloader pattern in
download_rasters.py::download_soilgrids() — same WCS endpoint family and the
same EPSG:4326 -> ESRI:54052 (Interrupted Goode Homolosine) bbox transform that
SoilGrids requires.

SoilGrids ships texture as weight fractions in g/kg (0-1000); hsg.py rescales.

Usage:
    python download_soilgrids_texture.py            # sand+silt+clay, 0-5cm
    python download_soilgrids_texture.py --depth 5-15cm
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import requests

from config import BBOX, CITY_NAME, fix_proj

fix_proj()

OUT_DIR = Path(__file__).parent.parent / "data" / "rasters"
OUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("soilgrids-texture")

# SoilGrids 2.0 property -> WCS map file. Each is served from its own mapfile.
PROPERTIES = ("sand", "silt", "clay")


def _homolosine_bbox() -> tuple[float, float, float, float]:
    """Guna bbox transformed EPSG:4326 -> ESRI:54052 (SoilGrids native CRS)."""
    from pyproj import Transformer

    tf = Transformer.from_crs("EPSG:4326", "ESRI:54052", always_xy=True)
    x_min, y_min = tf.transform(BBOX["west"], BBOX["south"])
    x_max, y_max = tf.transform(BBOX["east"], BBOX["north"])
    return x_min, y_min, x_max, y_max


def download_property(prop: str, depth: str = "0-5cm", timeout: int = 180) -> Path:
    """Fetch one SoilGrids texture property (sand|silt|clay) as a clipped GeoTIFF."""
    out_path = OUT_DIR / f"soilgrids_{prop}_{depth}_{CITY_NAME}.tif"
    if out_path.exists():
        log.info("Already exists: %s", out_path.name)
        return out_path

    x_min, y_min, x_max, y_max = _homolosine_bbox()
    url = f"https://maps.isric.org/mapserv?map=/map/{prop}.map"
    params = {
        "SERVICE": "WCS",
        "VERSION": "2.0.1",
        "REQUEST": "GetCoverage",
        "COVERAGEID": f"{prop}_{depth}_mean",
        "FORMAT": "image/tiff",
        "SUBSET": [f"X({x_min},{x_max})", f"Y({y_min},{y_max})"],
    }
    log.info("Fetching SoilGrids %s %s ...", prop, depth)
    resp = requests.get(url, params=params, timeout=timeout)
    if resp.status_code == 200 and len(resp.content) > 1000:
        out_path.write_bytes(resp.content)
        log.info("Saved: %s (%.0f KB)", out_path.name, len(resp.content) / 1024)
        return out_path
    log.warning("SoilGrids WCS %s returned status %d (%d bytes)",
                prop, resp.status_code, len(resp.content))
    return Path()


def download_texture(depth: str = "0-5cm") -> dict[str, Path]:
    """Fetch sand, silt and clay for the given depth. Returns {prop: path}."""
    results: dict[str, Path] = {}
    for prop in PROPERTIES:
        try:
            path = download_property(prop, depth)
            if path:
                results[prop] = path
        except Exception as exc:  # noqa: BLE001 - one bad property shouldn't abort the rest
            log.error("FAILED %s: %s", prop, exc)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Download SoilGrids texture for Guna")
    parser.add_argument("--depth", default="0-5cm", help="SoilGrids depth (e.g. 0-5cm, 5-15cm)")
    args = parser.parse_args()
    got = download_texture(args.depth)
    log.info("Downloaded %d/%d properties: %s", len(got), len(PROPERTIES), ", ".join(got))


if __name__ == "__main__":
    main()
