"""
Informal Settlement Index from Building Morphology
====================================================
Computes per-DigiPin-cell morphological features from building footprints
and road network data, then derives an Informality Index (0-1).

Features per cell:
  - building_count      : number of buildings whose centroid falls in cell
  - avg_area_m2         : mean building footprint area
  - size_cv             : coefficient of variation of building areas
  - orientation_entropy : Shannon entropy of building orientations (normalised)
  - road_access_ratio   : fraction of buildings within 20 m of a road segment
  - building_density    : total footprint area / cell area

Informality Index:
  Weighted combination after min-max normalisation:
    high size_cv + high orientation_entropy + low road_access + high density
    + low avg_area => more informal

Outputs:
  - settlement_index_guna.geojson  (cell centroids with scores)
  - settlement_index_summary.json  (distribution statistics)

Usage:
    python settlement_index.py
    python settlement_index.py --buildings osm   # use OSM buildings (default)
    python settlement_index.py --buildings google # use Google Open Buildings
    python settlement_index.py --cell-size 0.0006 # ~66 m cell side
"""

import argparse
import json
import logging
import math
import sys
from pathlib import Path

from config import BBOX_CITY, CITY_NAME, VECTOR_DIR

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
EARTH_RADIUS_M = 6_371_000

# Default cell size in degrees (~64 m at ~24.6° N latitude)
DEFAULT_CELL_SIZE_DEG = 0.000576

# Road proximity threshold in metres
ROAD_PROXIMITY_M = 20.0

# Number of orientation bins for entropy calculation
ORIENTATION_BINS = 18  # 10° bins over 0-180°

# Informality index weights (sum to 1.0)
WEIGHTS = {
    "size_cv": 0.20,
    "orientation_entropy": 0.20,
    "inv_road_access": 0.20,  # inverted: low access = high informality
    "building_density": 0.15,
    "inv_avg_area": 0.15,     # inverted: small buildings = more informal
    "building_count_norm": 0.10,
}

# Minimum buildings in a cell to compute meaningful metrics
MIN_BUILDINGS_PER_CELL = 3


# ---------------------------------------------------------------------------
# Geometry helpers (stdlib only)
# ---------------------------------------------------------------------------

def haversine(lon1, lat1, lon2, lat2):
    """Return distance in metres between two WGS-84 points."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    )
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def polygon_area_m2(ring):
    """Compute approximate area in m² for a polygon ring [[lon, lat], ...].

    Uses the Shoelace formula on projected coordinates.
    Projects lon/lat to local metres using the ring centroid as reference.
    """
    n = len(ring)
    if n < 3:
        return 0.0

    # Compute centroid for local projection
    cx = sum(p[0] for p in ring) / n
    cy = sum(p[1] for p in ring) / n

    cos_lat = math.cos(math.radians(cy))
    m_per_deg_lat = math.radians(1.0) * EARTH_RADIUS_M
    m_per_deg_lon = m_per_deg_lat * cos_lat

    # Project to local metres
    projected = []
    for p in ring:
        x = (p[0] - cx) * m_per_deg_lon
        y = (p[1] - cy) * m_per_deg_lat
        projected.append((x, y))

    # Shoelace formula
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += projected[i][0] * projected[j][1]
        area -= projected[j][0] * projected[i][1]
    return abs(area) / 2.0


def polygon_centroid(ring):
    """Compute centroid (lon, lat) of a polygon ring."""
    n = len(ring)
    if n == 0:
        return (0.0, 0.0)
    cx = sum(p[0] for p in ring) / n
    cy = sum(p[1] for p in ring) / n
    return (cx, cy)


def building_orientation(ring):
    """Compute dominant orientation angle (0-180°) of a building footprint.

    Uses the longest edge of the polygon to determine orientation.
    Returns angle in degrees from East, wrapped to [0, 180).
    """
    if len(ring) < 3:
        return 0.0

    best_len_sq = 0.0
    best_angle = 0.0

    for i in range(len(ring) - 1):
        dx = ring[i + 1][0] - ring[i][0]
        dy = ring[i + 1][1] - ring[i][1]
        len_sq = dx * dx + dy * dy
        if len_sq > best_len_sq:
            best_len_sq = len_sq
            best_angle = math.degrees(math.atan2(dy, dx))

    # Wrap to [0, 180) — orientation is undirected
    angle = best_angle % 180.0
    if angle < 0:
        angle += 180.0
    return angle


def point_to_segment_distance(px, py, ax, ay, bx, by):
    """Compute minimum distance from point (px,py) to segment (ax,ay)-(bx,by).

    All coordinates in metres (projected). Returns distance in metres.
    """
    dx = bx - ax
    dy = by - ay
    len_sq = dx * dx + dy * dy

    if len_sq == 0:
        return math.hypot(px - ax, py - ay)

    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len_sq))
    proj_x = ax + t * dx
    proj_y = ay + t * dy
    return math.hypot(px - proj_x, py - proj_y)


def shannon_entropy(counts, num_bins):
    """Compute normalised Shannon entropy from a list of bin counts.

    Returns value in [0, 1] where 1 = maximum entropy (uniform distribution).
    """
    total = sum(counts)
    if total == 0:
        return 0.0

    entropy = 0.0
    for c in counts:
        if c > 0:
            p = c / total
            entropy -= p * math.log2(p)

    max_entropy = math.log2(num_bins) if num_bins > 1 else 1.0
    return entropy / max_entropy if max_entropy > 0 else 0.0


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_buildings(source="osm"):
    """Load building footprints from GeoJSON.

    Returns list of dicts: {centroid: (lon, lat), area_m2, orientation, ring}.
    """
    if source == "google":
        path = VECTOR_DIR / f"google_open_buildings_{CITY_NAME}.geojson"
    else:
        path = VECTOR_DIR / f"osm_buildings_{CITY_NAME}.geojson"

    if not path.exists():
        log.error("Building file not found: %s", path)
        sys.exit(1)

    log.info("Loading buildings from %s", path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features", [])
    log.info("Loaded %d building features", len(features))

    buildings = []
    skipped = 0

    for feat in features:
        geom = feat.get("geometry", {})
        gtype = geom.get("type", "")
        coords = geom.get("coordinates", [])

        ring = None
        if gtype == "Polygon" and coords:
            ring = coords[0]  # outer ring
        elif gtype == "MultiPolygon" and coords:
            # Use the largest polygon
            best_ring = None
            best_area = 0.0
            for poly_coords in coords:
                if poly_coords:
                    r = poly_coords[0]
                    a = polygon_area_m2(r)
                    if a > best_area:
                        best_area = a
                        best_ring = r
            ring = best_ring

        if ring is None or len(ring) < 3:
            skipped += 1
            continue

        area = polygon_area_m2(ring)
        if area < 1.0:  # skip degenerate footprints
            skipped += 1
            continue

        centroid = polygon_centroid(ring)
        orientation = building_orientation(ring)

        buildings.append({
            "centroid": centroid,
            "area_m2": area,
            "orientation": orientation,
            "ring": ring,
        })

    if skipped > 0:
        log.info("Skipped %d degenerate or empty features", skipped)
    log.info("Processed %d valid buildings", len(buildings))
    return buildings


def load_road_segments():
    """Load road segments as lists of coordinate pairs.

    Returns list of segments, where each segment is [(lon1,lat1), (lon2,lat2)].
    """
    path = VECTOR_DIR / f"osm_roads_{CITY_NAME}.geojson"
    if not path.exists():
        log.warning("Road file not found: %s — road access will be 0", path)
        return []

    log.info("Loading roads from %s", path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features", [])
    segments = []

    for feat in features:
        geom = feat.get("geometry", {})
        gtype = geom.get("type", "")
        coords = geom.get("coordinates", [])

        coord_lists = []
        if gtype == "LineString":
            coord_lists = [coords]
        elif gtype == "MultiLineString":
            coord_lists = coords

        for clist in coord_lists:
            for i in range(len(clist) - 1):
                segments.append((
                    (clist[i][0], clist[i][1]),
                    (clist[i + 1][0], clist[i + 1][1]),
                ))

    log.info("Loaded %d road segments", len(segments))
    return segments


# ---------------------------------------------------------------------------
# Spatial index: simple grid-based lookup for road segments
# ---------------------------------------------------------------------------

def build_road_index(segments, cell_deg=0.005):
    """Build a coarse grid index for road segments.

    Each grid cell maps to a list of segment indices that overlap it.
    cell_deg ~= 500 m, so each lookup checks a manageable number of segments.
    """
    index = {}

    for idx, (p1, p2) in enumerate(segments):
        min_lon = min(p1[0], p2[0])
        max_lon = max(p1[0], p2[0])
        min_lat = min(p1[1], p2[1])
        max_lat = max(p1[1], p2[1])

        col_start = int(min_lon / cell_deg)
        col_end = int(max_lon / cell_deg)
        row_start = int(min_lat / cell_deg)
        row_end = int(max_lat / cell_deg)

        for col in range(col_start, col_end + 1):
            for row in range(row_start, row_end + 1):
                key = (col, row)
                if key not in index:
                    index[key] = []
                index[key].append(idx)

    return index, cell_deg


def is_near_road(bld_lon, bld_lat, segments, road_index, index_cell_deg,
                 threshold_m=ROAD_PROXIMITY_M):
    """Check if a building centroid is within threshold_m of any road segment."""
    if not segments:
        return False

    cos_lat = math.cos(math.radians(bld_lat))
    m_per_deg_lat = math.radians(1.0) * EARTH_RADIUS_M
    m_per_deg_lon = m_per_deg_lat * cos_lat

    # Convert building position to metres (local origin irrelevant for distance)
    bx = bld_lon * m_per_deg_lon
    by = bld_lat * m_per_deg_lat

    # Search in nearby coarse-grid cells
    col = int(bld_lon / index_cell_deg)
    row = int(bld_lat / index_cell_deg)

    checked = set()
    for dc in range(-1, 2):
        for dr in range(-1, 2):
            key = (col + dc, row + dr)
            seg_indices = road_index.get(key, [])
            for si in seg_indices:
                if si in checked:
                    continue
                checked.add(si)

                p1, p2 = segments[si]
                ax = p1[0] * m_per_deg_lon
                ay = p1[1] * m_per_deg_lat
                ex = p2[0] * m_per_deg_lon
                ey = p2[1] * m_per_deg_lat

                dist = point_to_segment_distance(bx, by, ax, ay, ex, ey)
                if dist <= threshold_m:
                    return True

    return False


# ---------------------------------------------------------------------------
# Grid generation and cell assignment
# ---------------------------------------------------------------------------

def generate_grid_cells(bbox, cell_size_deg):
    """Generate grid cells covering the bounding box.

    Returns dict: (col, row) -> {west, south, east, north, centroid_lon, centroid_lat}.
    """
    west = bbox["west"]
    south = bbox["south"]
    east = bbox["east"]
    north = bbox["north"]

    cols = int(math.ceil((east - west) / cell_size_deg))
    rows = int(math.ceil((north - south) / cell_size_deg))

    log.info("Grid: %d cols x %d rows = %d cells (%.6f° cell size)",
             cols, rows, cols * rows, cell_size_deg)

    cells = {}
    for c in range(cols):
        for r in range(rows):
            cw = west + c * cell_size_deg
            cs = south + r * cell_size_deg
            ce = cw + cell_size_deg
            cn = cs + cell_size_deg
            cells[(c, r)] = {
                "west": cw,
                "south": cs,
                "east": ce,
                "north": cn,
                "centroid_lon": (cw + ce) / 2.0,
                "centroid_lat": (cs + cn) / 2.0,
            }

    return cells


def assign_buildings_to_cells(buildings, bbox, cell_size_deg):
    """Assign each building to a grid cell based on its centroid.

    Returns dict: (col, row) -> list of building dicts.
    """
    west = bbox["west"]
    south = bbox["south"]

    cell_map = {}

    for bld in buildings:
        lon, lat = bld["centroid"]
        if lon < bbox["west"] or lon > bbox["east"]:
            continue
        if lat < bbox["south"] or lat > bbox["north"]:
            continue

        col = int((lon - west) / cell_size_deg)
        row = int((lat - south) / cell_size_deg)
        key = (col, row)

        if key not in cell_map:
            cell_map[key] = []
        cell_map[key].append(bld)

    return cell_map


# ---------------------------------------------------------------------------
# Per-cell morphological feature computation
# ---------------------------------------------------------------------------

def compute_cell_features(cell_buildings, cell_info, segments, road_index,
                          index_cell_deg):
    """Compute morphological features for buildings in a single cell.

    Returns dict of features or None if insufficient data.
    """
    count = len(cell_buildings)
    if count < MIN_BUILDINGS_PER_CELL:
        return None

    # --- Building areas ---
    areas = [b["area_m2"] for b in cell_buildings]
    avg_area = sum(areas) / count
    total_area = sum(areas)

    # Coefficient of variation of building sizes
    if avg_area > 0 and count > 1:
        variance = sum((a - avg_area) ** 2 for a in areas) / (count - 1)
        std_dev = math.sqrt(variance)
        size_cv = std_dev / avg_area
    else:
        size_cv = 0.0

    # --- Cell area in m² ---
    cell_width_m = haversine(
        cell_info["west"], cell_info["centroid_lat"],
        cell_info["east"], cell_info["centroid_lat"],
    )
    cell_height_m = haversine(
        cell_info["centroid_lon"], cell_info["south"],
        cell_info["centroid_lon"], cell_info["north"],
    )
    cell_area_m2 = cell_width_m * cell_height_m

    # --- Building density ---
    building_density = total_area / cell_area_m2 if cell_area_m2 > 0 else 0.0
    building_density = min(building_density, 1.0)  # cap at 1.0

    # --- Orientation entropy ---
    bin_width = 180.0 / ORIENTATION_BINS
    orientation_counts = [0] * ORIENTATION_BINS
    for b in cell_buildings:
        bin_idx = int(b["orientation"] / bin_width)
        bin_idx = min(bin_idx, ORIENTATION_BINS - 1)
        orientation_counts[bin_idx] += 1

    orient_entropy = shannon_entropy(orientation_counts, ORIENTATION_BINS)

    # --- Road access ratio ---
    if segments:
        near_road_count = 0
        for b in cell_buildings:
            lon, lat = b["centroid"]
            if is_near_road(lon, lat, segments, road_index, index_cell_deg):
                near_road_count += 1
        road_access = near_road_count / count
    else:
        road_access = 0.0

    return {
        "building_count": count,
        "avg_area_m2": round(avg_area, 2),
        "total_area_m2": round(total_area, 2),
        "size_cv": round(size_cv, 4),
        "orientation_entropy": round(orient_entropy, 4),
        "road_access_ratio": round(road_access, 4),
        "building_density": round(building_density, 4),
        "cell_area_m2": round(cell_area_m2, 2),
    }


# ---------------------------------------------------------------------------
# Normalisation and informality index
# ---------------------------------------------------------------------------

def min_max_normalise(values):
    """Return min-max normalised values in [0, 1]. Handles empty/constant."""
    if not values:
        return []
    lo = min(values)
    hi = max(values)
    rng = hi - lo
    if rng == 0:
        return [0.5] * len(values)
    return [(v - lo) / rng for v in values]


def compute_informality_index(cell_results):
    """Add normalised features and informality_index to each cell result.

    Mutates cell_results in place (returns new list of dicts with added fields).
    """
    if not cell_results:
        return []

    # Extract raw feature arrays
    size_cvs = [r["size_cv"] for r in cell_results]
    entropies = [r["orientation_entropy"] for r in cell_results]
    road_access = [r["road_access_ratio"] for r in cell_results]
    densities = [r["building_density"] for r in cell_results]
    avg_areas = [r["avg_area_m2"] for r in cell_results]
    counts = [r["building_count"] for r in cell_results]

    # Normalise
    n_size_cv = min_max_normalise(size_cvs)
    n_entropy = min_max_normalise(entropies)
    n_road_access = min_max_normalise(road_access)
    n_density = min_max_normalise(densities)
    n_avg_area = min_max_normalise(avg_areas)
    n_count = min_max_normalise(counts)

    enriched = []
    for i, r in enumerate(cell_results):
        # Invert road_access and avg_area (low value = more informal)
        inv_road = 1.0 - n_road_access[i]
        inv_area = 1.0 - n_avg_area[i]

        informality = (
            WEIGHTS["size_cv"] * n_size_cv[i]
            + WEIGHTS["orientation_entropy"] * n_entropy[i]
            + WEIGHTS["inv_road_access"] * inv_road
            + WEIGHTS["building_density"] * n_density[i]
            + WEIGHTS["inv_avg_area"] * inv_area
            + WEIGHTS["building_count_norm"] * n_count[i]
        )

        enriched.append({
            **r,
            "norm_size_cv": round(n_size_cv[i], 4),
            "norm_orientation_entropy": round(n_entropy[i], 4),
            "norm_inv_road_access": round(inv_road, 4),
            "norm_building_density": round(n_density[i], 4),
            "norm_inv_avg_area": round(inv_area, 4),
            "norm_building_count": round(n_count[i], 4),
            "informality_index": round(informality, 4),
        })

    return enriched


# ---------------------------------------------------------------------------
# Output generation
# ---------------------------------------------------------------------------

def build_geojson(enriched_cells, grid_cells):
    """Build a GeoJSON FeatureCollection from enriched cell results."""
    features = []

    for cell_key, result in enriched_cells:
        cell = grid_cells[cell_key]
        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [
                    round(cell["centroid_lon"], 6),
                    round(cell["centroid_lat"], 6),
                ],
            },
            "properties": {
                "cell_col": cell_key[0],
                "cell_row": cell_key[1],
                **result,
            },
        }
        features.append(feature)

    return {
        "type": "FeatureCollection",
        "features": features,
    }


def build_summary(enriched_cells):
    """Build summary statistics from enriched cell results."""
    if not enriched_cells:
        return {"error": "no cells with sufficient buildings"}

    scores = [r["informality_index"] for _, r in enriched_cells]
    counts = [r["building_count"] for _, r in enriched_cells]
    areas = [r["avg_area_m2"] for _, r in enriched_cells]
    densities = [r["building_density"] for _, r in enriched_cells]

    def stats(values, label):
        n = len(values)
        if n == 0:
            return {}
        sorted_v = sorted(values)
        mean = sum(sorted_v) / n
        median = sorted_v[n // 2]
        return {
            f"{label}_min": round(sorted_v[0], 4),
            f"{label}_max": round(sorted_v[-1], 4),
            f"{label}_mean": round(mean, 4),
            f"{label}_median": round(median, 4),
            f"{label}_p90": round(sorted_v[int(n * 0.9)], 4) if n > 1 else round(sorted_v[0], 4),
            f"{label}_p95": round(sorted_v[int(n * 0.95)], 4) if n > 1 else round(sorted_v[0], 4),
        }

    # Classification thresholds
    high_informality = sum(1 for s in scores if s >= 0.7)
    medium_informality = sum(1 for s in scores if 0.4 <= s < 0.7)
    low_informality = sum(1 for s in scores if s < 0.4)

    return {
        "city": CITY_NAME,
        "total_cells_analysed": len(enriched_cells),
        "min_buildings_per_cell": MIN_BUILDINGS_PER_CELL,
        "total_buildings_in_cells": sum(counts),
        "classification": {
            "high_informality_cells": high_informality,
            "medium_informality_cells": medium_informality,
            "low_informality_cells": low_informality,
        },
        "weights": WEIGHTS,
        **stats(scores, "informality"),
        **stats(areas, "avg_area_m2"),
        **stats(densities, "density"),
        "methodology": (
            "Informal settlement index computed from building morphology. "
            "Features: size variance (CV), orientation entropy, road access ratio, "
            "building density, average area. Weighted combination after min-max "
            "normalisation per feature. High index = more informal characteristics."
        ),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Compute informal settlement index from building morphology"
    )
    parser.add_argument(
        "--buildings",
        choices=["osm", "google"],
        default="osm",
        help="Building data source: osm (default) or google",
    )
    parser.add_argument(
        "--cell-size",
        type=float,
        default=DEFAULT_CELL_SIZE_DEG,
        help=f"Grid cell size in degrees (default: {DEFAULT_CELL_SIZE_DEG})",
    )
    parser.add_argument(
        "--skip-roads",
        action="store_true",
        help="Skip road access computation (faster, but no road_access_ratio)",
    )
    args = parser.parse_args()

    output_geojson = VECTOR_DIR / f"settlement_index_{CITY_NAME}.geojson"
    output_summary = VECTOR_DIR / f"settlement_index_summary.json"

    # --- Load data ---
    buildings = load_buildings(source=args.buildings)
    if not buildings:
        log.error("No buildings loaded. Exiting.")
        sys.exit(1)

    segments = []
    road_index = {}
    index_cell_deg = 0.005
    if not args.skip_roads:
        segments = load_road_segments()
        if segments:
            road_index, index_cell_deg = build_road_index(segments)
            log.info("Road spatial index built (%d coarse cells)", len(road_index))
    else:
        log.info("Skipping road data (--skip-roads)")

    # --- Build grid and assign buildings ---
    grid_cells = generate_grid_cells(BBOX_CITY, args.cell_size)
    cell_buildings = assign_buildings_to_cells(buildings, BBOX_CITY, args.cell_size)

    in_bbox_count = sum(len(v) for v in cell_buildings.values())
    log.info("Buildings within city bbox: %d / %d", in_bbox_count, len(buildings))

    # --- Compute per-cell features ---
    log.info("Computing morphological features per cell...")
    cell_results = []
    processed = 0
    total_cells_with_buildings = len(cell_buildings)

    for cell_key, blds in cell_buildings.items():
        if cell_key not in grid_cells:
            continue

        features = compute_cell_features(
            blds, grid_cells[cell_key],
            segments, road_index, index_cell_deg,
        )
        if features is not None:
            cell_results.append((cell_key, features))

        processed += 1
        if processed % 500 == 0:
            log.info("  Processed %d / %d cells...", processed, total_cells_with_buildings)

    log.info("Cells with sufficient buildings (>=%d): %d",
             MIN_BUILDINGS_PER_CELL, len(cell_results))

    if not cell_results:
        log.error("No cells have enough buildings for analysis. "
                  "Try a larger cell size or different data source.")
        sys.exit(1)

    # --- Normalise and compute informality index ---
    log.info("Computing informality index...")
    raw_features = [r for _, r in cell_results]
    enriched = compute_informality_index(raw_features)

    enriched_cells = [
        (cell_results[i][0], enriched[i])
        for i in range(len(cell_results))
    ]

    # --- Sort by informality (highest first) for summary ---
    enriched_cells.sort(key=lambda x: -x[1]["informality_index"])

    # --- Output GeoJSON ---
    geojson = build_geojson(enriched_cells, grid_cells)
    VECTOR_DIR.mkdir(parents=True, exist_ok=True)
    with open(output_geojson, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    log.info("Wrote %d cell features to %s", len(enriched_cells), output_geojson)

    # --- Output summary ---
    summary = build_summary(enriched_cells)
    with open(output_summary, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    log.info("Wrote summary to %s", output_summary)

    # --- Console summary ---
    log.info("=== Settlement Informality Summary ===")
    log.info("Cells analysed: %d", len(enriched_cells))
    log.info("Informality range: %.4f - %.4f",
             summary.get("informality_min", 0),
             summary.get("informality_max", 0))
    log.info("Informality mean:  %.4f", summary.get("informality_mean", 0))
    log.info("Informality p90:   %.4f", summary.get("informality_p90", 0))
    cls = summary.get("classification", {})
    log.info("High informality cells:   %d", cls.get("high_informality_cells", 0))
    log.info("Medium informality cells: %d", cls.get("medium_informality_cells", 0))
    log.info("Low informality cells:    %d", cls.get("low_informality_cells", 0))

    # Top 5 most informal cells
    log.info("--- Top 5 Most Informal Cells ---")
    for cell_key, result in enriched_cells[:5]:
        log.info("  Cell (%d,%d): index=%.4f  buildings=%d  avg_area=%.1f m²  "
                 "density=%.3f  road_access=%.2f",
                 cell_key[0], cell_key[1],
                 result["informality_index"],
                 result["building_count"],
                 result["avg_area_m2"],
                 result["building_density"],
                 result["road_access_ratio"])

    log.info("Done.")


if __name__ == "__main__":
    main()
