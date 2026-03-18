"""
DigiPin Digital Twin — Building Footprints Download (Guna)
==========================================================
Downloads building footprints for Guna from two sources:

1. **Microsoft Global ML Building Footprints** (primary)
   - Dataset links: https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv
   - Format: GeoJSON-Lines (.csv.gz) keyed by quadkey
   - Coverage: ~1B buildings worldwide

2. **Google Open Buildings v3** (backup)
   - S2 cell CSV from Google Cloud Storage
   - Format: CSV with WKT geometry

The script resolves which quadkey tiles cover Guna's BBOX, downloads the
corresponding .csv.gz files (line-delimited GeoJSON), filters buildings
inside the city boundary, and writes a single GeoJSON FeatureCollection.

Uses only stdlib + gzip — no third-party dependencies.

Usage:
    python download_buildings.py                          # default
    python download_buildings.py --source microsoft       # Microsoft only
    python download_buildings.py --source google          # Google only
    python download_buildings.py --confidence 0.75        # higher confidence (Google)
"""

import argparse
import gzip
import io
import json
import logging
import math
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from config import BBOX_CITY, CITY_NAME, GUNA_BOUNDARY, VECTOR_DIR

OUT_DIR = VECTOR_DIR
OUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("download_buildings")

# ── Microsoft dataset-links URL ──────────────────────────────────────────────
MS_DATASET_LINKS_URL = (
    "https://minedbuildings.z5.web.core.windows.net/"
    "global-buildings/dataset-links.csv"
)

# ── Google Open Buildings v3 ─────────────────────────────────────────────────
GOOGLE_S2_CELL = "397"
GOOGLE_BASE_URL = (
    "https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip"
)


# ─────────────────────────────────────────────────────────────────────────────
#  Quadkey utilities (Bing Maps tile system)
# ─────────────────────────────────────────────────────────────────────────────
def lat_lon_to_tile(lat: float, lon: float, zoom: int) -> tuple[int, int]:
    """Convert lat/lon to tile x, y at given zoom level."""
    lat_rad = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    x = max(0, min(n - 1, x))
    y = max(0, min(n - 1, y))
    return x, y


def tile_to_quadkey(x: int, y: int, zoom: int) -> str:
    """Convert tile x, y, zoom to a quadkey string."""
    quadkey = []
    for i in range(zoom, 0, -1):
        digit = 0
        mask = 1 << (i - 1)
        if (x & mask) != 0:
            digit += 1
        if (y & mask) != 0:
            digit += 2
        quadkey.append(str(digit))
    return "".join(quadkey)


def get_covering_quadkeys(bbox: dict, zoom: int) -> list[str]:
    """Return all quadkeys at given zoom level that intersect the bbox."""
    min_x, min_y = lat_lon_to_tile(bbox["north"], bbox["west"], zoom)
    max_x, max_y = lat_lon_to_tile(bbox["south"], bbox["east"], zoom)
    quadkeys = []
    for x in range(min_x, max_x + 1):
        for y in range(min_y, max_y + 1):
            quadkeys.append(tile_to_quadkey(x, y, zoom))
    return quadkeys


# ─────────────────────────────────────────────────────────────────────────────
#  Geometry helpers
# ─────────────────────────────────────────────────────────────────────────────
def point_in_bbox(lon: float, lat: float, bbox: dict) -> bool:
    """Check if a point falls within the bounding box."""
    return (
        bbox["west"] <= lon <= bbox["east"]
        and bbox["south"] <= lat <= bbox["north"]
    )


def point_in_polygon(lon: float, lat: float, polygon: list) -> bool:
    """Ray casting algorithm for point-in-polygon test."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / (yj - yi) + xi
        ):
            inside = not inside
        j = i
    return inside


def geometry_centroid(geometry: dict) -> tuple[float, float]:
    """Return approximate centroid (lon, lat) of a GeoJSON geometry."""
    gtype = geometry.get("type", "")
    coords = geometry.get("coordinates", [])

    if gtype == "Point":
        return coords[0], coords[1]
    elif gtype == "Polygon" and coords:
        ring = coords[0]
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        return sum(lons) / len(lons), sum(lats) / len(lats)
    elif gtype == "MultiPolygon" and coords:
        ring = coords[0][0]
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        return sum(lons) / len(lons), sum(lats) / len(lats)
    return 0.0, 0.0


def polygon_area_approx(geometry: dict) -> float:
    """Approximate area in m² using the Shoelace formula with lat/lon scaling."""
    gtype = geometry.get("type", "")
    coords = geometry.get("coordinates", [])

    if gtype == "Polygon" and coords:
        ring = coords[0]
    elif gtype == "MultiPolygon" and coords:
        ring = coords[0][0]
    else:
        return 0.0

    if len(ring) < 3:
        return 0.0

    # Approximate meters per degree at Guna's latitude (~24.6°N)
    lat_mid = sum(p[1] for p in ring) / len(ring)
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(lat_mid))

    # Shoelace formula
    area = 0.0
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        x_i = ring[i][0] * m_per_deg_lon
        y_i = ring[i][1] * m_per_deg_lat
        x_j = ring[j][0] * m_per_deg_lon
        y_j = ring[j][1] * m_per_deg_lat
        area += x_i * y_j - x_j * y_i

    return abs(area) / 2.0


# ─────────────────────────────────────────────────────────────────────────────
#  Microsoft Global ML Building Footprints
# ─────────────────────────────────────────────────────────────────────────────
def fetch_ms_dataset_links() -> list[dict]:
    """Download and parse the Microsoft dataset-links.csv."""
    log.info("Fetching Microsoft dataset-links.csv ...")
    req = urllib.request.Request(
        MS_DATASET_LINKS_URL,
        headers={"User-Agent": "DigiPin-Pipeline/1.0"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")

    lines = raw.strip().splitlines()
    if not lines:
        return []

    header = lines[0].split(",")
    rows = []
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) >= len(header):
            row = dict(zip(header, parts))
            rows.append(row)
    log.info("Parsed %d entries from dataset-links.csv", len(rows))
    return rows


def find_ms_links_for_guna(rows: list[dict], bbox: dict) -> list[dict]:
    """
    Find dataset-links rows whose quadkey tiles overlap Guna's BBOX.

    Microsoft uses zoom level 9 quadkeys. We check all zoom levels 1-12
    and match any row whose quadkey is a prefix of, or matches, a covering
    tile at that zoom.
    """
    # Filter to India / IND rows first
    india_rows = [
        r for r in rows
        if r.get("Location", "").lower() in ("india", "ind")
    ]
    if not india_rows:
        # Fallback: try all rows
        log.warning("No India-specific rows found; searching all rows...")
        india_rows = rows

    log.info("India rows: %d", len(india_rows))

    # Determine quadkey zoom level from the dataset
    # The QuadKey column tells us the zoom level by its string length
    quadkey_col = None
    for col in ("QuadKey", "quadkey", "Quadkey"):
        if col in (india_rows[0] if india_rows else {}):
            quadkey_col = col
            break

    if not quadkey_col:
        log.warning("No QuadKey column found. Columns: %s",
                     list(rows[0].keys()) if rows else "empty")
        return india_rows[:5]  # Return first few India rows as fallback

    # Group rows by quadkey length (zoom level)
    zoom_lengths = set()
    for r in india_rows:
        qk = r.get(quadkey_col, "")
        if qk:
            zoom_lengths.add(len(qk))

    log.info("Quadkey zoom levels found: %s", sorted(zoom_lengths))

    matched = []
    for zoom in sorted(zoom_lengths):
        covering = get_covering_quadkeys(bbox, zoom)
        log.info("  Zoom %d: Guna covered by quadkeys %s", zoom, covering)
        for r in india_rows:
            qk = r.get(quadkey_col, "")
            if len(qk) == zoom and qk in covering:
                matched.append(r)

    # Also try prefix matching: a dataset quadkey is a prefix of our
    # covering quadkeys (i.e. a larger tile that contains Guna)
    if not matched:
        log.info("No exact match; trying prefix matching...")
        max_zoom = max(zoom_lengths) if zoom_lengths else 12
        covering_fine = get_covering_quadkeys(bbox, max_zoom)
        for r in india_rows:
            qk = r.get(quadkey_col, "")
            for cq in covering_fine:
                if cq.startswith(qk) or qk.startswith(cq):
                    matched.append(r)
                    break

    # Deduplicate
    seen_urls = set()
    unique = []
    url_col = None
    for col in ("Url", "url", "URL"):
        if col in (matched[0] if matched else {}):
            url_col = col
            break

    for r in matched:
        u = r.get(url_col or "Url", "")
        if u not in seen_urls:
            seen_urls.add(u)
            unique.append(r)

    log.info("Matched %d tile(s) covering Guna", len(unique))
    return unique


def download_ms_buildings(bbox: dict, use_polygon: bool = True) -> list[dict]:
    """
    Download Microsoft building footprints for Guna.

    Steps:
      1. Fetch dataset-links.csv
      2. Find quadkey tiles covering Guna
      3. Download each .csv.gz (line-delimited GeoJSON)
      4. Stream-filter buildings within BBOX/polygon
    """
    rows = fetch_ms_dataset_links()
    if not rows:
        log.error("Failed to fetch dataset-links.csv")
        return []

    links = find_ms_links_for_guna(rows, bbox)
    if not links:
        log.error("No matching tiles found for Guna")
        return []

    url_col = None
    for col in ("Url", "url", "URL"):
        if col in links[0]:
            url_col = col
            break

    if not url_col:
        log.error("Cannot find URL column in dataset links")
        return []

    features = []
    polygon = GUNA_BOUNDARY if use_polygon else None

    for link_info in links:
        url = link_info[url_col]
        log.info("Downloading: %s", url)

        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "DigiPin-Pipeline/1.0"}
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                if url.endswith(".gz"):
                    raw_stream = gzip.GzipFile(fileobj=io.BytesIO(resp.read()))
                else:
                    raw_stream = io.BytesIO(resp.read())

                reader = io.TextIOWrapper(raw_stream, encoding="utf-8", errors="replace")

                scanned = 0
                matched = 0
                start = time.time()
                last_log = start

                for line in reader:
                    scanned += 1
                    line = line.strip()
                    if not line:
                        continue

                    now = time.time()
                    if now - last_log > 30:
                        rate = scanned / (now - start)
                        log.info("  Scanned %d rows (%.0f/sec), matched %d ...",
                                 scanned, rate, matched)
                        last_log = now

                    try:
                        feature = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    geom = feature.get("geometry", {})
                    lon, lat = geometry_centroid(geom)

                    # Fast bbox filter
                    if not point_in_bbox(lon, lat, bbox):
                        continue

                    # Polygon filter
                    if polygon and not point_in_polygon(lon, lat, polygon):
                        continue

                    # Extract / compute properties
                    props = feature.get("properties", {})
                    area = props.get("area_in_meters", 0.0)
                    if not area:
                        area = polygon_area_approx(geom)

                    height = props.get("height", None)
                    confidence = props.get("confidence", None)

                    new_props = {"area_m2": round(area, 2)}
                    if confidence is not None:
                        new_props["confidence"] = confidence
                    if height is not None:
                        new_props["height_m"] = height

                    features.append({
                        "type": "Feature",
                        "geometry": geom,
                        "properties": new_props,
                    })
                    matched += 1

                elapsed = time.time() - start
                log.info("  Tile done: scanned %d, matched %d in %.1fs",
                         scanned, matched, elapsed)

        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            log.error("Failed to download %s: %s", url, exc)
            continue

    return features


# ─────────────────────────────────────────────────────────────────────────────
#  Google Open Buildings v3 (backup)
# ─────────────────────────────────────────────────────────────────────────────
def download_google_buildings(
    bbox: dict, confidence: float = 0.65, use_polygon: bool = True
) -> list[dict]:
    """
    Stream-download Google Open Buildings v3 CSV and filter to Guna.
    Uses urllib (stdlib) instead of requests.
    """
    url = f"{GOOGLE_BASE_URL}/{GOOGLE_S2_CELL}_buildings.csv.gz"
    log.info("Streaming Google Open Buildings v3 (S2 cell %s) ...", GOOGLE_S2_CELL)
    log.info("Filter: confidence >= %.2f, bbox [%.4f,%.4f]-[%.4f,%.4f]",
             confidence, bbox["west"], bbox["south"], bbox["east"], bbox["north"])

    req = urllib.request.Request(url, headers={"User-Agent": "DigiPin-Pipeline/1.0"})

    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        log.error("Google download failed: %s", exc)
        return []

    decompressor = gzip.GzipFile(fileobj=resp)
    reader = io.TextIOWrapper(decompressor, encoding="utf-8", errors="replace")

    header = reader.readline().strip()
    columns = header.split(",")
    log.info("Columns: %s", columns)

    lat_idx = columns.index("latitude")
    lon_idx = columns.index("longitude")
    area_idx = columns.index("area_in_meters")
    conf_idx = columns.index("confidence")

    features = []
    scanned = 0
    matched = 0
    start = time.time()
    last_log = start
    polygon = GUNA_BOUNDARY if use_polygon else None

    for line in reader:
        scanned += 1

        now = time.time()
        if now - last_log > 30:
            rate = scanned / (now - start)
            log.info("  Scanned %d rows (%.0f/sec), matched %d ...",
                     scanned, rate, matched)
            last_log = now

        try:
            parts = line.strip().split(",", 4)
            if len(parts) < 5:
                continue

            lat = float(parts[lat_idx])
            lon = float(parts[lon_idx])

            if not point_in_bbox(lon, lat, bbox):
                continue

            if polygon and not point_in_polygon(lon, lat, polygon):
                continue

            area = float(parts[area_idx])
            conf = float(parts[conf_idx])

            if conf < confidence:
                continue

            # Parse WKT geometry
            remainder = parts[4]
            geometry = _parse_wkt_polygon(remainder, lon, lat)

            features.append({
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "area_m2": round(area, 2),
                    "confidence": conf,
                },
            })
            matched += 1

        except (ValueError, IndexError):
            continue

    resp.close()
    elapsed = time.time() - start
    log.info("Google scan complete: %d rows in %.0fs, %d matched",
             scanned, elapsed, matched)

    return features


def _parse_wkt_polygon(remainder: str, lon: float, lat: float) -> dict:
    """Parse WKT POLYGON from CSV remainder into GeoJSON geometry."""
    geom_wkt = ""
    if remainder.startswith('"'):
        end_quote = remainder.find('"', 1)
        if end_quote > 0:
            geom_wkt = remainder[1:end_quote]
    else:
        sub = remainder.split(",", 1)
        geom_wkt = sub[0].strip()

    if geom_wkt.startswith("POLYGON"):
        try:
            inner = geom_wkt[geom_wkt.index("((") + 2 : geom_wkt.rindex("))")]
            coords = []
            for pt in inner.split(","):
                xy = pt.strip().split(" ")[:2]
                coords.append([float(xy[0]), float(xy[1])])
            if len(coords) >= 4:
                return {"type": "Polygon", "coordinates": [coords]}
        except Exception:
            pass

    return {"type": "Point", "coordinates": [lon, lat]}


# ─────────────────────────────────────────────────────────────────────────────
#  Output & stats
# ─────────────────────────────────────────────────────────────────────────────
def print_stats(features: list[dict], source: str) -> None:
    """Print summary statistics of downloaded buildings."""
    if not features:
        log.info("No buildings to report.")
        return

    total = len(features)
    areas = [f["properties"].get("area_m2", 0) for f in features]
    with_height = sum(1 for f in features if f["properties"].get("height_m") is not None)
    with_confidence = [
        f["properties"]["confidence"]
        for f in features
        if f["properties"].get("confidence") is not None
    ]
    polygons = sum(1 for f in features if f["geometry"]["type"] == "Polygon")

    areas_valid = [a for a in areas if a > 0]
    areas_valid.sort()

    print("\n" + "=" * 60)
    print(f"  Building Footprints — {source}")
    print("=" * 60)
    print(f"  Total buildings found:   {total:,}")
    print(f"  Polygon geometries:      {polygons:,}")
    print(f"  Point geometries:        {total - polygons:,}")
    print(f"  With height estimates:   {with_height:,}")

    if with_confidence:
        avg_conf = sum(with_confidence) / len(with_confidence)
        print(f"  Avg confidence:          {avg_conf:.3f}")

    if areas_valid:
        print(f"\n  Area distribution (m²):")
        print(f"    Min:     {areas_valid[0]:,.1f}")
        print(f"    Median:  {areas_valid[len(areas_valid) // 2]:,.1f}")
        print(f"    Mean:    {sum(areas_valid) / len(areas_valid):,.1f}")
        print(f"    Max:     {areas_valid[-1]:,.1f}")

        # Size buckets
        tiny = sum(1 for a in areas_valid if a < 50)
        small = sum(1 for a in areas_valid if 50 <= a < 200)
        medium = sum(1 for a in areas_valid if 200 <= a < 500)
        large = sum(1 for a in areas_valid if 500 <= a < 2000)
        xlarge = sum(1 for a in areas_valid if a >= 2000)

        print(f"\n  Size categories:")
        print(f"    < 50 m² (tiny):        {tiny:,}")
        print(f"    50-200 m² (small):     {small:,}")
        print(f"    200-500 m² (medium):   {medium:,}")
        print(f"    500-2000 m² (large):   {large:,}")
        print(f"    > 2000 m² (x-large):   {xlarge:,}")

    print("=" * 60 + "\n")


def save_geojson(features: list[dict], source: str) -> Path:
    """Save features as a GeoJSON FeatureCollection."""
    out_path = OUT_DIR / f"google_open_buildings_{CITY_NAME}.geojson"

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "source": source,
            "city": CITY_NAME,
            "bbox": [
                BBOX_CITY["west"], BBOX_CITY["south"],
                BBOX_CITY["east"], BBOX_CITY["north"],
            ],
            "total_buildings": len(features),
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "features": features,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f)

    size_mb = out_path.stat().st_size / (1024 * 1024)
    log.info("Saved: %s (%.1f MB, %d buildings)", out_path.name, size_mb, len(features))
    return out_path


# ─────────────────────────────────────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Download building footprints for Guna (Microsoft + Google)"
    )
    parser.add_argument(
        "--source",
        choices=["microsoft", "google", "both"],
        default="both",
        help="Data source: microsoft, google, or both (default: both)",
    )
    parser.add_argument(
        "--confidence",
        type=float,
        default=0.65,
        help="Min confidence for Google buildings (default: 0.65)",
    )
    parser.add_argument(
        "--bbox-only",
        action="store_true",
        help="Use bbox filter only (skip polygon filter)",
    )
    args = parser.parse_args()

    bbox = BBOX_CITY
    use_polygon = not args.bbox_only
    features = []
    source_label = ""

    # ── Microsoft (primary) ──────────────────────────────────────────────
    if args.source in ("microsoft", "both"):
        log.info("=" * 50)
        log.info("Source 1: Microsoft Global ML Building Footprints")
        log.info("=" * 50)
        ms_features = download_ms_buildings(bbox, use_polygon=use_polygon)
        if ms_features:
            features = ms_features
            source_label = "Microsoft Global ML Building Footprints"
            log.info("Microsoft: %d buildings found", len(ms_features))
        else:
            log.warning("Microsoft: no buildings found for Guna")

    # ── Google (backup) ──────────────────────────────────────────────────
    if args.source in ("google", "both"):
        if features and args.source == "both":
            log.info("Microsoft data available; skipping Google backup.")
        else:
            log.info("=" * 50)
            log.info("Source 2: Google Open Buildings v3 (backup)")
            log.info("=" * 50)
            g_features = download_google_buildings(
                bbox, confidence=args.confidence, use_polygon=use_polygon
            )
            if g_features:
                if not features:
                    features = g_features
                    source_label = "Google Open Buildings v3"
                else:
                    # Merge — add Google buildings that don't overlap with MS
                    features.extend(g_features)
                    source_label += " + Google Open Buildings v3"
                log.info("Google: %d buildings found", len(g_features))
            else:
                log.warning("Google: no buildings found for Guna")

    if not features:
        log.error("No buildings found from any source!")
        sys.exit(1)

    # ── Save & report ────────────────────────────────────────────────────
    out_path = save_geojson(features, source_label)
    print_stats(features, source_label)

    log.info("Done! Output: %s", out_path)


if __name__ == "__main__":
    main()
