"""
DigiPin Digital Twin — Sentinel-2 Imagery Download (Guna)
=========================================================
Downloads Sentinel-2 L2A imagery for Guna from Microsoft Planetary Computer
STAC API (free, no authentication required).

Downloads 10m bands (B02, B03, B04, B08), 20m bands (B05-B07, B11, B12),
and the Scene Classification Layer (SCL) for the most recent clear scene.

Usage:
    python download_sentinel2.py                          # download latest clear scene
    python download_sentinel2.py --max-cloud 20           # allow up to 20% cloud
    python download_sentinel2.py --date-range 2024-01-01 2024-06-30
    python download_sentinel2.py --list                   # list matching scenes

Requires: pip install pystac-client rasterio planetary-computer
"""

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import planetary_computer as pc
    import pystac_client
    import rasterio
    from rasterio.mask import mask as rio_mask
    from rasterio.warp import transform_geom
    from rasterio.windows import from_bounds
    from shapely.geometry import box
except ImportError as e:
    print(f"\nMissing dependency: {e.name}")
    print("\nInstall required packages:")
    print("  pip install pystac-client rasterio planetary-computer shapely")
    print("\nNote: rasterio on Windows may require pre-built wheels:")
    print("  pip install rasterio --find-links https://github.com/cgohlke/geospatial-wheels/releases")
    sys.exit(1)

from config import BBOX_CITY, CITY_NAME, DATA_DIR, fix_proj

fix_proj()

# ─── Constants ────────────────────────────────────────────────────

STAC_API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
COLLECTION = "sentinel-2-l2a"

BBOX_TUPLE = (BBOX_CITY["west"], BBOX_CITY["south"], BBOX_CITY["east"], BBOX_CITY["north"])
AOI = box(*BBOX_TUPLE)
AOI_GEOM = [AOI.__geo_interface__]

# Bands to download: (asset_key, description, resolution)
BANDS = [
    ("B02", "Blue", "10m"),
    ("B03", "Green", "10m"),
    ("B04", "Red", "10m"),
    ("B08", "NIR", "10m"),
    ("B05", "Red Edge 1", "20m"),
    ("B06", "Red Edge 2", "20m"),
    ("B07", "Red Edge 3", "20m"),
    ("B11", "SWIR1", "20m"),
    ("B12", "SWIR2", "20m"),
    ("SCL", "Scene Classification", "20m"),
]

OUT_DIR = DATA_DIR / "satellite" / "sentinel2_guna"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("sentinel2")


# ─── STAC Query ──────────────────────────────────────────────────


def search_scenes(max_cloud: float = 10.0,
                  date_range: str = "2023-01-01/..") -> list:
    """Search Planetary Computer for Sentinel-2 L2A scenes over Guna."""
    log.info("Connecting to Planetary Computer STAC API...")
    catalog = pystac_client.Client.open(
        STAC_API_URL,
        modifier=pc.sign_inplace,
    )

    log.info(
        "Searching collection=%s, bbox=%s, cloud<%.0f%%, dates=%s",
        COLLECTION, BBOX_TUPLE, max_cloud, date_range,
    )

    search = catalog.search(
        collections=[COLLECTION],
        bbox=BBOX_TUPLE,
        datetime=date_range,
        query={"eo:cloud_cover": {"lt": max_cloud}},
        sortby=[{"field": "properties.datetime", "direction": "desc"}],
        max_items=50,
    )

    items = list(search.items())
    log.info("Found %d scenes with cloud cover < %.0f%%", len(items), max_cloud)
    return items


def pick_best_scene(items: list) -> object:
    """Select the most recent scene from search results."""
    if not items:
        log.error("No scenes found. Try increasing --max-cloud or widening --date-range.")
        return None

    # Items are already sorted by date descending from the API
    best = items[0]
    props = best.properties
    log.info(
        "Selected scene: %s | Date: %s | Cloud: %.1f%%",
        best.id,
        props.get("datetime", "unknown"),
        props.get("eo:cloud_cover", -1),
    )
    return best


# ─── Download & Crop ─────────────────────────────────────────────


def download_and_crop_band(item, band_key: str, out_dir: Path) -> Path:
    """Download a single band from a STAC item, cropped to BBOX_CITY."""
    if band_key not in item.assets:
        log.warning("Band %s not found in scene assets. Skipping.", band_key)
        return Path()

    scene_date = item.properties.get("datetime", "")[:10]
    out_path = out_dir / f"{CITY_NAME}_{scene_date}_{band_key}.tif"

    if out_path.exists():
        log.info("Already exists: %s", out_path.name)
        return out_path

    asset = item.assets[band_key]
    href = asset.href
    log.info("Downloading %s from %s ...", band_key, href[:80] + "...")

    with rasterio.open(href) as src:
        # Reproject AOI from WGS84 to raster CRS if needed
        raster_crs = src.crs
        if raster_crs and "4326" not in str(raster_crs):
            try:
                from pyproj import Transformer
                transformer = Transformer.from_crs("EPSG:4326", raster_crs, always_xy=True)
                west, south, east, north = BBOX_TUPLE
                coords = [(west, south), (east, south), (east, north), (west, north), (west, south)]
                projected_coords = [transformer.transform(x, y) for x, y in coords]
                reprojected = [{"type": "Polygon", "coordinates": [projected_coords]}]
            except Exception as proj_err:
                log.warning("pyproj reprojection failed (%s), trying rasterio...", proj_err)
                reprojected = [transform_geom("EPSG:4326", raster_crs, g) for g in AOI_GEOM]
        else:
            reprojected = AOI_GEOM
        out_image, out_transform = rio_mask(src, reprojected, crop=True, all_touched=True)
        profile = src.profile.copy()
        profile.update({
            "driver": "GTiff",
            "height": out_image.shape[1],
            "width": out_image.shape[2],
            "transform": out_transform,
            "compress": "lzw",
            "tiled": True,
            "blockxsize": 256,
            "blockysize": 256,
        })

    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(out_image)

    size_mb = out_path.stat().st_size / (1024 * 1024)
    log.info("Saved: %s (%.2f MB)", out_path.name, size_mb)
    return out_path


def download_scene(item) -> dict:
    """Download all configured bands for a scene, return metadata dict."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    scene_id = item.id
    props = item.properties
    scene_date = props.get("datetime", "")[:10]
    cloud_cover = props.get("eo:cloud_cover", -1)

    log.info("=" * 60)
    log.info("Downloading scene: %s", scene_id)
    log.info("Date: %s | Cloud cover: %.1f%%", scene_date, cloud_cover)
    log.info("Output: %s", OUT_DIR)
    log.info("=" * 60)

    band_paths = {}
    failed_bands = []

    for band_key, description, resolution in BANDS:
        try:
            path = download_and_crop_band(item, band_key, OUT_DIR)
            if path and path.exists():
                band_paths[band_key] = {
                    "file": path.name,
                    "description": description,
                    "resolution": resolution,
                    "size_mb": round(path.stat().st_size / (1024 * 1024), 2),
                }
            else:
                failed_bands.append(band_key)
        except Exception as e:
            log.error("Failed to download %s: %s", band_key, e)
            failed_bands.append(band_key)

    # Build metadata
    metadata = {
        "scene_id": scene_id,
        "collection": COLLECTION,
        "date": scene_date,
        "datetime": props.get("datetime", ""),
        "cloud_cover_pct": cloud_cover,
        "platform": props.get("platform", ""),
        "mgrs_tile": props.get("s2:mgrs_tile", ""),
        "processing_level": props.get("s2:processing_level", "Level-2A"),
        "bbox_city": dict(BBOX_CITY),
        "crs": "EPSG:32643",
        "bands": band_paths,
        "failed_bands": failed_bands,
        "download_timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "Microsoft Planetary Computer",
        "stac_api": STAC_API_URL,
    }

    # Save metadata JSON
    meta_path = OUT_DIR / f"{CITY_NAME}_{scene_date}_metadata.json"
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)
    log.info("Metadata saved: %s", meta_path.name)

    # Summary
    log.info("\n=== Download Summary ===")
    log.info("Scene: %s (%s)", scene_id, scene_date)
    log.info("Bands downloaded: %d / %d", len(band_paths), len(BANDS))
    if failed_bands:
        log.warning("Failed bands: %s", ", ".join(failed_bands))
    total_mb = sum(b["size_mb"] for b in band_paths.values())
    log.info("Total size: %.1f MB", total_mb)

    return metadata


# ─── CLI ─────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Download Sentinel-2 imagery for Guna from Planetary Computer"
    )
    parser.add_argument(
        "--max-cloud", type=float, default=10.0,
        help="Maximum cloud cover percentage (default: 10)",
    )
    parser.add_argument(
        "--date-range", nargs=2, metavar=("START", "END"),
        default=None,
        help="Date range as START END (e.g., 2024-01-01 2024-12-31)",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List matching scenes without downloading",
    )
    parser.add_argument(
        "--scene-index", type=int, default=0,
        help="Index of scene to download (0=most recent, default: 0)",
    )
    args = parser.parse_args()

    # Build date range string
    if args.date_range:
        date_str = f"{args.date_range[0]}/{args.date_range[1]}"
    else:
        date_str = "2023-01-01/.."

    # Search for scenes
    items = search_scenes(max_cloud=args.max_cloud, date_range=date_str)

    if not items:
        log.error("No scenes found. Try --max-cloud 30 or a wider --date-range.")
        sys.exit(1)

    # List mode
    if args.list:
        print(f"\n{'Idx':>3}  {'Scene ID':50s}  {'Date':12s}  {'Cloud%':>7s}  {'Platform'}")
        print("-" * 90)
        for i, item in enumerate(items):
            p = item.properties
            print(
                f"{i:3d}  {item.id:50s}  {p.get('datetime', '')[:10]:12s}"
                f"  {p.get('eo:cloud_cover', -1):6.1f}%  {p.get('platform', '')}"
            )
        print(f"\nUse --scene-index N to download a specific scene.")
        return

    # Validate scene index
    if args.scene_index >= len(items):
        log.error(
            "Scene index %d out of range (found %d scenes). Use --list to see options.",
            args.scene_index, len(items),
        )
        sys.exit(1)

    # Download
    selected = items[args.scene_index]
    download_scene(selected)


if __name__ == "__main__":
    main()
