"""
DigiPin Digital Twin — Raster Data Downloads
=============================================
Downloads DEM, LULC, population, night lights, building height, flood risk
for Indore. All sources are free and require no authentication.

Usage:
    python download_rasters.py                    # download all
    python download_rasters.py --layer dem        # download specific layer
    python download_rasters.py --list             # list available layers

Requires: pip install rasterio requests numpy shapely
Optional: pip install earthaccess (for NASA datasets)
"""

import argparse
import logging
import sys
import time
from pathlib import Path

import numpy as np
import requests
import rasterio
from rasterio.mask import mask as rio_mask
from shapely.geometry import box

from config import BBOX, fix_proj

fix_proj()

OUT_DIR = Path(__file__).parent.parent / "data" / "rasters"
OUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("rasters")

AOI = box(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"])
AOI_GEOM = [AOI.__geo_interface__]


def _download_file(url: str, dest: Path, timeout: int = 600) -> Path:
    """Download a file with progress logging."""
    if dest.exists():
        log.info("Already exists: %s", dest.name)
        return dest
    log.info("Downloading %s ...", dest.name)
    resp = requests.get(url, stream=True, timeout=timeout)
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0))
    downloaded = 0
    with open(dest, "wb") as f:
        for chunk in resp.iter_content(chunk_size=65536):
            f.write(chunk)
            downloaded += len(chunk)
    size_mb = downloaded / (1024 * 1024)
    log.info("Saved: %s (%.1f MB)", dest.name, size_mb)
    return dest


def _clip_raster(src_path: Path, dst_path: Path) -> Path:
    """Clip a GeoTIFF to the Indore AOI bounding box."""
    with rasterio.open(src_path) as src:
        out_image, out_transform = rio_mask(src, AOI_GEOM, crop=True)
        profile = src.profile.copy()
        profile.update({
            "height": out_image.shape[1],
            "width": out_image.shape[2],
            "transform": out_transform,
            "compress": "lzw",
        })
    with rasterio.open(dst_path, "w", **profile) as dst:
        dst.write(out_image)
    log.info("Clipped: %s", dst_path.name)
    return dst_path


# ─── Layer Downloaders ───────────────────────────────────────────


def download_srtm_dem(api_key: str = "") -> Path:
    """SRTM 30m DEM via OpenTopography (requires free API key)."""
    if not api_key:
        log.warning("SRTM: Provide OpenTopography API key via --opentopo-key")
        log.info("Register free at: https://portal.opentopography.org/requestKey")
        return Path()
    url = (
        f"https://portal.opentopography.org/API/globaldem?"
        f"demtype=SRTMGL1&west={BBOX['west']}&south={BBOX['south']}"
        f"&east={BBOX['east']}&north={BBOX['north']}"
        f"&outputFormat=GTiff&API_Key={api_key}"
    )
    return _download_file(url, OUT_DIR / "srtm_30m_indore.tif")


def download_copernicus_dem(api_key: str = "") -> Path:
    """Copernicus DEM GLO-30 via OpenTopography."""
    if not api_key:
        log.warning("COP DEM: Provide OpenTopography API key via --opentopo-key")
        return Path()
    url = (
        f"https://portal.opentopography.org/API/globaldem?"
        f"demtype=COP30&west={BBOX['west']}&south={BBOX['south']}"
        f"&east={BBOX['east']}&north={BBOX['north']}"
        f"&outputFormat=GTiff&API_Key={api_key}"
    )
    return _download_file(url, OUT_DIR / "cop_dem_30m_indore.tif")


def download_esa_worldcover() -> Path:
    """ESA WorldCover 10m LULC 2021 (no auth, direct S3)."""
    tile_url = (
        "https://esa-worldcover.s3.amazonaws.com/v200/2021/map/"
        "ESA_WorldCover_10m_2021_v200_N21E075_Map.tif"
    )
    raw = _download_file(tile_url, OUT_DIR / "worldcover_N21E075_raw.tif", timeout=900)
    if raw.exists():
        return _clip_raster(raw, OUT_DIR / "worldcover_10m_indore.tif")
    return Path()


def download_worldpop() -> Path:
    """WorldPop 1km population density 2020 (no auth)."""
    url = (
        "https://data.worldpop.org/GIS/Population/"
        "Global_2000_2020_1km/2020/IND/ind_ppp_2020_1km_Aggregated.tif"
    )
    raw = _download_file(url, OUT_DIR / "worldpop_1km_india.tif", timeout=900)
    if raw.exists():
        return _clip_raster(raw, OUT_DIR / "worldpop_1km_indore.tif")
    return Path()


def download_ghsl_pop() -> Path:
    """GHSL GHS-POP 100m population 2020 (no auth, JRC)."""
    # This is a global file (~2GB) — download only if needed
    url = (
        "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
        "GHS_POP_GLOBE_R2023A/GHS_POP_E2020_GLOBE_R2023A_4326_100/"
        "V1-0/GHS_POP_E2020_GLOBE_R2023A_4326_100_V1_0.zip"
    )
    log.info("GHSL POP: Global file is ~2GB. Skipping auto-download.")
    log.info("Download manually from: %s", url)
    log.info("Then clip with: python -c \"from download_rasters import _clip_raster; ...\"")
    return Path()


def download_ghsl_building_height() -> Path:
    """GHSL Building Height 100m (no auth, JRC)."""
    url = (
        "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
        "GHS_BUILT_H_GLOBE_R2023A/"
        "GHS_BUILT_H_AGBH_E2018_GLOBE_R2023A_4326_100/V1-0/"
        "GHS_BUILT_H_AGBH_E2018_GLOBE_R2023A_4326_100_V1_0.zip"
    )
    log.info("GHSL Building Height: Global file is ~1GB. Skipping auto-download.")
    log.info("Download manually from: %s", url)
    return Path()


def download_jrc_surface_water() -> Path:
    """JRC Global Surface Water occurrence 30m (no auth, Google Cloud)."""
    url = (
        "https://storage.googleapis.com/global-surface-water/"
        "downloads2021/occurrence/occurrence_70E_30Nv1_4_2021.tif"
    )
    raw = _download_file(url, OUT_DIR / "jrc_water_70E_30N_raw.tif", timeout=600)
    if raw.exists():
        return _clip_raster(raw, OUT_DIR / "jrc_surface_water_indore.tif")
    return Path()


def download_openmeteo_climate() -> Path:
    """Open-Meteo historical daily weather 2023 (no auth, JSON → parquet)."""
    import json

    url = "https://archive.open-meteo.com/v1/archive"
    params = {
        "latitude": 22.7196,
        "longitude": 75.8577,
        "start_date": "2023-01-01",
        "end_date": "2023-12-31",
        "daily": ",".join([
            "temperature_2m_max", "temperature_2m_min",
            "precipitation_sum", "wind_speed_10m_max",
            "relative_humidity_2m_max", "et0_fao_evapotranspiration",
        ]),
        "timezone": "Asia/Kolkata",
    }
    log.info("Fetching Open-Meteo climate data for 2023...")
    resp = requests.get(url, params=params, timeout=60)
    resp.raise_for_status()
    data = resp.json()

    out_path = OUT_DIR / "openmeteo_daily_indore_2023.json"
    with open(out_path, "w") as f:
        json.dump(data, f, indent=2)
    log.info("Saved: %s (%d days)", out_path.name, len(data.get("daily", {}).get("time", [])))
    return out_path


def download_soilgrids() -> Path:
    """ISRIC SoilGrids 250m pH via WCS (no auth)."""
    from pyproj import Transformer

    transformer = Transformer.from_crs("EPSG:4326", "ESRI:54052", always_xy=True)
    x_min, y_min = transformer.transform(BBOX["west"], BBOX["south"])
    x_max, y_max = transformer.transform(BBOX["east"], BBOX["north"])

    url = "https://maps.isric.org/mapserv?map=/map/phh2o.map"
    params = {
        "SERVICE": "WCS",
        "VERSION": "2.0.1",
        "REQUEST": "GetCoverage",
        "COVERAGEID": "phh2o_0-5cm_mean",
        "FORMAT": "image/tiff",
        "SUBSET": [f"X({x_min},{x_max})", f"Y({y_min},{y_max})"],
    }
    log.info("Fetching SoilGrids pH 0-5cm...")
    resp = requests.get(url, params=params, timeout=120)
    if resp.status_code == 200 and len(resp.content) > 1000:
        out_path = OUT_DIR / "soilgrids_ph_0-5cm_indore.tif"
        with open(out_path, "wb") as f:
            f.write(resp.content)
        log.info("Saved: %s", out_path.name)
        return out_path
    log.warning("SoilGrids WCS returned status %d", resp.status_code)
    return Path()


# ─── Layer Registry ──────────────────────────────────────────────

LAYERS = {
    "dem_srtm": ("SRTM 30m DEM", download_srtm_dem, True),
    "dem_cop": ("Copernicus DEM 30m", download_copernicus_dem, True),
    "lulc_worldcover": ("ESA WorldCover 10m", download_esa_worldcover, False),
    "pop_worldpop": ("WorldPop 1km", download_worldpop, False),
    "pop_ghsl": ("GHSL POP 100m", download_ghsl_pop, False),
    "building_height": ("GHSL Building Height 100m", download_ghsl_building_height, False),
    "water_jrc": ("JRC Surface Water 30m", download_jrc_surface_water, False),
    "climate": ("Open-Meteo Climate 2023", download_openmeteo_climate, False),
    "soil_ph": ("SoilGrids pH 250m", download_soilgrids, False),
}


def main():
    parser = argparse.ArgumentParser(description="Download raster data for Indore Digital Twin")
    parser.add_argument("--layer", help="Download specific layer (see --list)")
    parser.add_argument("--list", action="store_true", help="List available layers")
    parser.add_argument("--opentopo-key", default="", help="OpenTopography API key (free)")
    parser.add_argument("--all", action="store_true", help="Download all layers")
    args = parser.parse_args()

    if args.list:
        print("\nAvailable raster layers:")
        for key, (name, _, needs_key) in LAYERS.items():
            auth = " [needs --opentopo-key]" if needs_key else ""
            print(f"  {key:20s} — {name}{auth}")
        return

    if args.layer:
        if args.layer not in LAYERS:
            print(f"Unknown layer: {args.layer}. Use --list to see options.")
            return
        name, fn, needs_key = LAYERS[args.layer]
        log.info("Downloading: %s", name)
        if needs_key:
            fn(api_key=args.opentopo_key)
        else:
            fn()
        return

    if args.all:
        results = {}
        for key, (name, fn, needs_key) in LAYERS.items():
            try:
                if needs_key:
                    fn(api_key=args.opentopo_key)
                else:
                    fn()
                results[key] = "OK"
            except Exception as e:
                log.error("FAILED %s: %s", key, e)
                results[key] = f"FAILED: {e}"
            time.sleep(1)

        log.info("\n=== Download Summary ===")
        for key, status in results.items():
            log.info("  %s: %s", key, status)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
