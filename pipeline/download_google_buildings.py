"""
DigiPin Digital Twin — Google Open Buildings v3 Download
========================================================
Downloads building footprints for Indore from Google's Open Buildings v3
by streaming the large S2 cell CSV and filtering by bounding box.

The dataset at S2 level 4 (cell 397) covers all of central India (~5.6 GB).
This script streams it, decompresses on-the-fly, and only keeps buildings
within the Indore city boundary.

Dataset: https://sites.research.google/open-buildings/
Fields: latitude, longitude, area_in_meters, confidence, geometry (WKT), full_plus_code

Usage:
    python download_google_buildings.py                     # default (conf >= 0.65)
    python download_google_buildings.py --confidence 0.75   # higher confidence
    python download_google_buildings.py --format parquet    # GeoParquet output
"""

import argparse
import gzip
import io
import json
import time
from pathlib import Path

import requests

from config import BBOX_CITY, INDORE_BOUNDARY
from _lib.io import data_dir, setup_logging

OUT_DIR = data_dir("vectors")

log = setup_logging("google_buildings")

# S2 cell token for Indore at level 4 (computed via s2sphere)
S2_CELL = "397"
BASE_URL = "https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip"


def _point_in_polygon(lon, lat, polygon):
    """Ray casting algorithm for point-in-polygon test."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def download(confidence: float = 0.65, fmt: str = "geojson", use_polygon: bool = True) -> Path:
    """
    Stream-download Google Open Buildings CSV and filter to Indore.

    The CSV is gzipped (~5.6 GB compressed for cell 397).
    We stream it in chunks, decompress on-the-fly, and only keep rows
    within the Indore bbox/polygon.
    """
    url = f"{BASE_URL}/{S2_CELL}_buildings.csv.gz"

    log.info("Streaming Google Open Buildings v3 (S2 cell %s)...", S2_CELL)
    log.info("Filtering: confidence >= %.2f, bbox=%.4f,%.4f to %.4f,%.4f",
             confidence, BBOX_CITY["west"], BBOX_CITY["south"],
             BBOX_CITY["east"], BBOX_CITY["north"])

    resp = requests.get(url, stream=True, timeout=30)
    resp.raise_for_status()
    total_size = int(resp.headers.get("content-length", 0))
    log.info("Total file size: %.0f MB — streaming with bbox filter...", total_size / (1024 * 1024))

    # Stream decompression
    decompressor = gzip.GzipFile(fileobj=resp.raw)
    reader = io.TextIOWrapper(decompressor, encoding="utf-8", errors="replace")

    # Read header
    header = reader.readline().strip()
    columns = header.split(",")
    log.info("Columns: %s", columns)

    # Find column indices
    lat_idx = columns.index("latitude")
    lon_idx = columns.index("longitude")
    area_idx = columns.index("area_in_meters")
    conf_idx = columns.index("confidence")
    # geometry and full_plus_code are extracted from the remainder after the first 4 fields

    features = []
    total_scanned = 0
    matched = 0
    start_time = time.time()
    last_log = start_time

    bbox = BBOX_CITY
    polygon = INDORE_BOUNDARY if use_polygon else None

    for line in reader:
        total_scanned += 1

        # Progress logging every 30 seconds
        now = time.time()
        if now - last_log > 30:
            elapsed = now - start_time
            rate = total_scanned / elapsed
            log.info("  Scanned %d rows (%.0f/sec), matched %d buildings...",
                     total_scanned, rate, matched)
            last_log = now

        # Quick parse — split only the first 4 numeric fields for fast bbox filter.
        # The geometry column is a quoted WKT string with commas inside,
        # so we extract it separately after the bbox check passes.
        try:
            # Split on first 4 commas to get lat, lon, area, confidence
            parts = line.strip().split(",", 4)
            if len(parts) < 5:
                continue

            lat = float(parts[lat_idx])
            lon = float(parts[lon_idx])

            # Bbox filter (fast)
            if lat < bbox["south"] or lat > bbox["north"]:
                continue
            if lon < bbox["west"] or lon > bbox["east"]:
                continue

            # Polygon filter (more precise)
            if polygon and not _point_in_polygon(lon, lat, polygon):
                continue

            area = float(parts[area_idx])
            conf = float(parts[conf_idx])

            if conf < confidence:
                continue

            # Extract geometry WKT from the remainder (parts[4] has geometry + plus_code)
            remainder = parts[4]
            geom_wkt = ""
            plus_code = ""

            if remainder.startswith('"'):
                # Quoted geometry field — find the closing quote
                end_quote = remainder.find('"', 1)
                if end_quote > 0:
                    geom_wkt = remainder[1:end_quote]
                    # plus_code follows after the closing quote + comma
                    after = remainder[end_quote + 1:]
                    if after.startswith(","):
                        plus_code = after[1:].strip().strip('"')
            else:
                # No quotes — geometry might be a simple value or missing
                sub = remainder.split(",", 1)
                geom_wkt = sub[0].strip()
                if len(sub) > 1:
                    plus_code = sub[1].strip().strip('"')

            # Build GeoJSON feature — parse WKT polygon
            if geom_wkt.startswith("POLYGON"):
                try:
                    # WKT: POLYGON ((x1 y1, x2 y2, ...))
                    inner = geom_wkt[geom_wkt.index("((") + 2 : geom_wkt.rindex("))")]
                    coords = []
                    for pt in inner.split(","):
                        xy = pt.strip().split(" ")[:2]
                        coords.append([float(xy[0]), float(xy[1])])
                    if len(coords) >= 4:
                        geometry = {"type": "Polygon", "coordinates": [coords]}
                    else:
                        geometry = {"type": "Point", "coordinates": [lon, lat]}
                except Exception:
                    geometry = {"type": "Point", "coordinates": [lon, lat]}
            else:
                geometry = {"type": "Point", "coordinates": [lon, lat]}

            features.append({
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "confidence": conf,
                    "area_in_meters": area,
                    "full_plus_code": plus_code,
                    "latitude": lat,
                    "longitude": lon,
                }
            })
            matched += 1

        except (ValueError, IndexError):
            continue

    resp.close()
    elapsed = time.time() - start_time
    log.info("Scan complete: %d rows in %.0fs, %d buildings matched",
             total_scanned, elapsed, matched)

    if matched == 0:
        log.warning("No buildings found in Indore boundary!")
        return Path()

    # Save
    geojson = {"type": "FeatureCollection", "features": features}

    if fmt == "geojson":
        out_path = OUT_DIR / "google_open_buildings_indore.geojson"
        with open(out_path, "w") as f:
            json.dump(geojson, f)
        size_mb = out_path.stat().st_size / (1024 * 1024)
        log.info("Saved: %s (%.1f MB, %d buildings)", out_path.name, size_mb, matched)
        return out_path

    elif fmt == "parquet":
        try:
            import geopandas as gpd
            gdf = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
            out_path = OUT_DIR / "google_open_buildings_indore.parquet"
            gdf.to_parquet(out_path)
            size_mb = out_path.stat().st_size / (1024 * 1024)
            log.info("Saved: %s (%.1f MB, %d buildings)", out_path.name, size_mb, len(gdf))
            return out_path
        except ImportError:
            log.error("GeoParquet requires: pip install geopandas pyarrow")
            return Path()

    return Path()


def main():
    parser = argparse.ArgumentParser(
        description="Download Google Open Buildings v3 for Indore (stream-filtered)"
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
        "--bbox-only", action="store_true",
        help="Use bbox instead of polygon for filtering"
    )
    args = parser.parse_args()

    download(
        confidence=args.confidence,
        fmt=args.format,
        use_polygon=not args.bbox_only,
    )


if __name__ == "__main__":
    main()
