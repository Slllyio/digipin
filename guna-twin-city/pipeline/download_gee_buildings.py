"""
DigiPin Digital Twin — Google Open Buildings v3 via Earth Engine (Guna)
======================================================================
Downloads building footprints for Guna from Google's Open Buildings
dataset using the Earth Engine Python API.

Dataset: ee.FeatureCollection("GOOGLE/Research/open-buildings/v3/polygons")

Prerequisites:
    pip install earthengine-api geopandas
    earthengine authenticate   # one-time browser auth

Usage:
    python download_gee_buildings.py                          # default (confidence >= 0.65)
    python download_gee_buildings.py --confidence 0.75        # higher confidence
    python download_gee_buildings.py --export-drive           # export to Google Drive (large areas)
    python download_gee_buildings.py --format parquet         # save as GeoParquet
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from config import BBOX, CENTER_LAT, CENTER_LON, CITY_NAME

OUT_DIR = Path(__file__).parent.parent / "data" / "vectors"
OUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("gee_buildings")

# Google Open Buildings v3 asset ID
OPEN_BUILDINGS_V3 = "GOOGLE/Research/open-buildings/v3/polygons"


def _init_ee():
    """Initialize Earth Engine with authentication."""
    import ee
    try:
        ee.Initialize(opt_url="https://earthengine-highvolume.googleapis.com")
        log.info("Earth Engine initialized (high-volume endpoint)")
    except Exception:
        try:
            ee.Initialize()
            log.info("Earth Engine initialized (default endpoint)")
        except Exception:
            log.error(
                "Earth Engine not authenticated. Run:\n"
                "  earthengine authenticate\n"
                "Or visit: https://code.earthengine.google.com/"
            )
            sys.exit(1)
    return ee


def download_direct(confidence: float = 0.65, fmt: str = "geojson") -> Path:
    """
    Download buildings directly via getInfo() — works for city-scale areas.
    For very large areas (>500K buildings), use --export-drive instead.
    """
    ee = _init_ee()

    aoi = ee.Geometry.BBox(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"])

    log.info("Querying Google Open Buildings v3 for %s (confidence >= %.2f)...",
             CITY_NAME.title(), confidence)

    buildings = (
        ee.FeatureCollection(OPEN_BUILDINGS_V3)
        .filterBounds(aoi)
        .filter(ee.Filter.gte("confidence", confidence))
    )

    count = buildings.size().getInfo()
    log.info("Found %d buildings with confidence >= %.2f", count, confidence)

    if count == 0:
        log.warning("No buildings found. Check bbox or lower confidence threshold.")
        return Path()

    if count > 50000:
        log.warning(
            "Large dataset (%d buildings). Direct download may be slow.\n"
            "Consider using --export-drive for datasets > 50K features.",
            count,
        )

    buildings = buildings.select(
        ["confidence", "area_in_meters", "full_plus_code", "longitude", "latitude"]
    )

    BATCH_SIZE = 5000
    if count <= BATCH_SIZE:
        log.info("Downloading %d buildings...", count)
        fc = buildings.getInfo()
        all_features = fc.get("features", [])
    else:
        log.info("Downloading %d buildings in batches of %d...", count, BATCH_SIZE)
        all_features = []
        buildings_list = buildings.toList(count)

        for start in range(0, count, BATCH_SIZE):
            end = min(start + BATCH_SIZE, count)
            batch = ee.FeatureCollection(buildings_list.slice(start, end))
            batch_info = batch.getInfo()
            batch_features = batch_info.get("features", [])
            all_features.extend(batch_features)
            log.info("  Batch %d-%d: %d features", start, end, len(batch_features))
            time.sleep(1)

    log.info("Total downloaded: %d buildings", len(all_features))

    geojson = {"type": "FeatureCollection", "features": all_features}
    out_name = f"google_open_buildings_{CITY_NAME}"

    if fmt == "geojson":
        out_path = OUT_DIR / f"{out_name}.geojson"
        with open(out_path, "w") as f:
            json.dump(geojson, f)
        size_mb = out_path.stat().st_size / (1024 * 1024)
        log.info("Saved: %s (%.1f MB, %d buildings)", out_path.name, size_mb, len(all_features))
        return out_path

    elif fmt == "parquet":
        try:
            import geopandas as gpd
            gdf = gpd.GeoDataFrame.from_features(all_features, crs="EPSG:4326")
            out_path = OUT_DIR / f"{out_name}.parquet"
            gdf.to_parquet(out_path)
            size_mb = out_path.stat().st_size / (1024 * 1024)
            log.info("Saved: %s (%.1f MB, %d buildings)", out_path.name, size_mb, len(gdf))
            return out_path
        except ImportError:
            log.error("GeoParquet requires: pip install geopandas pyarrow")
            return Path()

    return Path()


def export_to_drive(confidence: float = 0.65) -> str:
    """
    Export to Google Drive as a GEE batch task.
    Best for large areas (>50K buildings). Check Drive after task completes.
    """
    ee = _init_ee()

    aoi = ee.Geometry.BBox(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"])

    buildings = (
        ee.FeatureCollection(OPEN_BUILDINGS_V3)
        .filterBounds(aoi)
        .filter(ee.Filter.gte("confidence", confidence))
        .select(["confidence", "area_in_meters", "full_plus_code", "longitude", "latitude"])
    )

    count = buildings.size().getInfo()
    log.info("Exporting %d buildings to Google Drive...", count)

    task = ee.batch.Export.table.toDrive(
        collection=buildings,
        description=f"google_open_buildings_{CITY_NAME}",
        folder="digipin_data",
        fileNamePrefix=f"google_open_buildings_{CITY_NAME}",
        fileFormat="GeoJSON",
    )
    task.start()
    task_id = task.id
    log.info("Export task started: %s", task_id)
    log.info("Check status at: https://code.earthengine.google.com/tasks")
    log.info("Output will appear in Google Drive folder: digipin_data/")

    log.info("Polling task status (Ctrl+C to stop polling, task continues on server)...")
    while True:
        status = task.status()
        state = status.get("state", "UNKNOWN")
        log.info("  Task state: %s", state)
        if state in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(30)

    if state == "COMPLETED":
        log.info("Export complete! Download from Google Drive: digipin_data/")
    else:
        log.error("Export %s: %s", state, status.get("error_message", ""))

    return task_id


def print_dataset_info():
    """Print metadata about the Open Buildings v3 dataset."""
    ee = _init_ee()

    aoi = ee.Geometry.BBox(BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"])
    buildings = ee.FeatureCollection(OPEN_BUILDINGS_V3).filterBounds(aoi)

    total = buildings.size().getInfo()

    high = buildings.filter(ee.Filter.gte("confidence", 0.75)).size().getInfo()
    medium = buildings.filter(
        ee.Filter.And(ee.Filter.gte("confidence", 0.50), ee.Filter.lt("confidence", 0.75))
    ).size().getInfo()
    low = buildings.filter(ee.Filter.lt("confidence", 0.50)).size().getInfo()

    areas = buildings.aggregate_stats("area_in_meters")
    area_stats = areas.getInfo()

    print(f"\n{'='*50}")
    print(f"Google Open Buildings v3 — {CITY_NAME.title()}")
    print(f"{'='*50}")
    print(f"Total buildings:      {total:,}")
    print(f"  High conf (>=0.75): {high:,}")
    print(f"  Med conf (0.5-0.75):{medium:,}")
    print(f"  Low conf (<0.50):   {low:,}")
    print(f"\nArea statistics (m2):")
    print(f"  Mean:   {area_stats.get('mean', 0):.1f}")
    print(f"  Min:    {area_stats.get('min', 0):.1f}")
    print(f"  Max:    {area_stats.get('max', 0):.1f}")
    print(f"  StdDev: {area_stats.get('stdDev', 0):.1f}")
    print(f"{'='*50}\n")


def main():
    parser = argparse.ArgumentParser(
        description=f"Download Google Open Buildings v3 for {CITY_NAME.title()} via Earth Engine"
    )
    parser.add_argument(
        "--confidence", type=float, default=0.65,
        help="Minimum confidence threshold (0-1, default: 0.65)"
    )
    parser.add_argument(
        "--format", choices=["geojson", "parquet"], default="geojson",
        help="Output format (default: geojson)"
    )
    parser.add_argument(
        "--export-drive", action="store_true",
        help="Export to Google Drive instead of direct download (for large areas)"
    )
    parser.add_argument(
        "--info", action="store_true",
        help="Print dataset statistics without downloading"
    )
    args = parser.parse_args()

    if args.info:
        print_dataset_info()
        return

    if args.export_drive:
        export_to_drive(confidence=args.confidence)
    else:
        download_direct(confidence=args.confidence, fmt=args.format)


if __name__ == "__main__":
    main()
