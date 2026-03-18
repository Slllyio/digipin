"""
Service Area Gap Analysis for Guna
====================================
Identify service coverage gaps for hospitals, schools, police, and fire stations
using URDPFI norms. Generates a grid of points over the city, computes distance
to the nearest facility of each type, and flags "service deserts" where the
distance exceeds the standard norm.

Output:
    data/vectors/service_gaps_guna.geojson   — gap points with gap_type & distance
    data/vectors/service_gaps_summary.json   — coverage statistics

Usage:
    python service_area_gaps.py
"""

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

# Grid spacing in metres
GRID_SPACING_M = 100

# URDPFI / planning norms — maximum acceptable distance in metres
SERVICE_NORMS = {
    "hospital":     1000,   # 1 km
    "school":        500,   # 500 m
    "police":       1500,   # 1.5 km
    "fire_station": 3000,   # 3 km
}

# Which GeoJSON categories map to each service type
CATEGORY_MAP = {
    "hospital":     ["hospital"],
    "school":       ["school"],
    "police":       ["police"],
    "fire_station": ["fire_station"],
}

# Input / output paths
INFRA_INPUT = VECTOR_DIR / f"sensitive_infrastructure_{CITY_NAME}.geojson"
GAPS_OUTPUT = VECTOR_DIR / f"service_gaps_{CITY_NAME}.geojson"
SUMMARY_OUTPUT = VECTOR_DIR / "service_gaps_summary.json"


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


def metres_to_deg_lat(metres):
    """Approximate conversion from metres to degrees latitude."""
    return metres / 111_320.0


def metres_to_deg_lon(metres, lat):
    """Approximate conversion from metres to degrees longitude at given latitude."""
    return metres / (111_320.0 * math.cos(math.radians(lat)))


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_facilities(geojson_path):
    """Load infrastructure GeoJSON and group facilities by service type.

    Returns:
        dict mapping service type -> list of (lon, lat) tuples
    """
    log.info("Loading infrastructure from %s", geojson_path)
    with open(geojson_path, encoding="utf-8") as f:
        data = json.load(f)

    facilities = {stype: [] for stype in SERVICE_NORMS}

    for feat in data.get("features", []):
        props = feat.get("properties", {})
        category = props.get("category", "")
        coords = feat.get("geometry", {}).get("coordinates", [])
        if len(coords) < 2:
            continue
        lon, lat = coords[0], coords[1]

        for stype, cats in CATEGORY_MAP.items():
            if category in cats:
                facilities[stype].append((lon, lat))

    for stype, locs in facilities.items():
        log.info("  %-15s %d facilities", stype, len(locs))

    return facilities


# ---------------------------------------------------------------------------
# Grid generation
# ---------------------------------------------------------------------------

def generate_grid(bbox, spacing_m):
    """Generate a list of (lon, lat) points covering bbox at given spacing.

    Returns:
        list of (lon, lat) tuples
    """
    south, north = bbox["south"], bbox["north"]
    west, east = bbox["west"], bbox["east"]
    mid_lat = (south + north) / 2.0

    dlat = metres_to_deg_lat(spacing_m)
    dlon = metres_to_deg_lon(spacing_m, mid_lat)

    points = []
    lat = south
    while lat <= north:
        lon = west
        while lon <= east:
            points.append((lon, lat))
            lon += dlon
        lat += dlat

    log.info("Generated %d grid points (%.0fm spacing)", len(points), spacing_m)
    return points


# ---------------------------------------------------------------------------
# Nearest-facility computation
# ---------------------------------------------------------------------------

def nearest_distance(point, facility_coords):
    """Return distance in metres from point to nearest facility.

    Args:
        point: (lon, lat) tuple
        facility_coords: list of (lon, lat) tuples

    Returns:
        float distance in metres, or math.inf if no facilities exist
    """
    if not facility_coords:
        return math.inf

    lon, lat = point
    min_dist = math.inf
    for flon, flat in facility_coords:
        d = haversine(lon, lat, flon, flat)
        if d < min_dist:
            min_dist = d
    return min_dist


# ---------------------------------------------------------------------------
# Gap analysis
# ---------------------------------------------------------------------------

def analyse_gaps(grid_points, facilities):
    """Identify service desert points for each facility type.

    Returns:
        tuple of (gap_features, per_type_stats) where:
            gap_features: list of GeoJSON Feature dicts
            per_type_stats: dict mapping service type -> stats dict
    """
    gap_features = []
    per_type_stats = {}
    total_points = len(grid_points)

    for stype, norm_m in SERVICE_NORMS.items():
        fac_coords = facilities.get(stype, [])
        gap_count = 0
        worst_dist = 0.0
        worst_point = None
        covered_count = 0

        log.info("Analysing %s (norm: %dm, facilities: %d)...",
                 stype, norm_m, len(fac_coords))

        for pt in grid_points:
            dist = nearest_distance(pt, fac_coords)
            if dist <= norm_m:
                covered_count += 1
            else:
                gap_count += 1
                gap_features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [round(pt[0], 6), round(pt[1], 6)],
                    },
                    "properties": {
                        "gap_type": stype,
                        "distance_m": round(dist, 1),
                        "norm_m": norm_m,
                        "excess_m": round(dist - norm_m, 1),
                    },
                })
                if dist > worst_dist:
                    worst_dist = dist
                    worst_point = pt

        coverage_pct = (covered_count / total_points * 100) if total_points > 0 else 0.0

        per_type_stats[stype] = {
            "norm_m": norm_m,
            "facility_count": len(fac_coords),
            "total_grid_points": total_points,
            "covered_points": covered_count,
            "gap_points": gap_count,
            "coverage_pct": round(coverage_pct, 2),
            "worst_distance_m": round(worst_dist, 1),
            "worst_point_lon": round(worst_point[0], 6) if worst_point else None,
            "worst_point_lat": round(worst_point[1], 6) if worst_point else None,
        }

        log.info("  %s: %.1f%% covered, %d gap points, worst=%.0fm",
                 stype, coverage_pct, gap_count, worst_dist)

    return gap_features, per_type_stats


def identify_gap_clusters(gap_features):
    """Group nearby gap points into clusters (simple greedy approach).

    Two gap points of the same type within 300m are considered part of the
    same cluster. Returns a list of cluster dicts with centroid and size.
    """
    clusters_by_type = {}
    for feat in gap_features:
        gtype = feat["properties"]["gap_type"]
        lon, lat = feat["geometry"]["coordinates"]
        clusters_by_type.setdefault(gtype, []).append((lon, lat))

    all_clusters = []
    cluster_radius_m = 300

    for gtype, points in clusters_by_type.items():
        assigned = [False] * len(points)
        for i, pt in enumerate(points):
            if assigned[i]:
                continue
            # Start a new cluster
            cluster_pts = [pt]
            assigned[i] = True
            for j in range(i + 1, len(points)):
                if assigned[j]:
                    continue
                if haversine(pt[0], pt[1], points[j][0], points[j][1]) <= cluster_radius_m:
                    cluster_pts.append(points[j])
                    assigned[j] = True
            centroid_lon = sum(p[0] for p in cluster_pts) / len(cluster_pts)
            centroid_lat = sum(p[1] for p in cluster_pts) / len(cluster_pts)
            all_clusters.append({
                "gap_type": gtype,
                "centroid_lon": round(centroid_lon, 6),
                "centroid_lat": round(centroid_lat, 6),
                "point_count": len(cluster_pts),
            })

    all_clusters.sort(key=lambda c: -c["point_count"])
    return all_clusters


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_gap_geojson(gap_features, output_path):
    """Write gap points as GeoJSON FeatureCollection."""
    geojson = {
        "type": "FeatureCollection",
        "features": gap_features,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    log.info("Wrote %d gap features to %s", len(gap_features), output_path)


def write_summary(per_type_stats, clusters, output_path):
    """Write summary statistics JSON."""
    summary = {
        "city": CITY_NAME,
        "grid_spacing_m": GRID_SPACING_M,
        "bbox": dict(BBOX_CITY),
        "service_coverage": per_type_stats,
        "gap_cluster_count": len(clusters),
        "gap_clusters": clusters[:50],  # top 50 largest clusters
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    log.info("Wrote summary to %s", output_path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log.info("=== Service Area Gap Analysis for %s ===", CITY_NAME.title())

    # Validate input
    if not INFRA_INPUT.exists():
        log.error("Infrastructure file not found: %s", INFRA_INPUT)
        log.error("Run enrich_crowd_capacity.py first to generate it.")
        sys.exit(1)

    # Step 1: Load facilities
    facilities = load_facilities(INFRA_INPUT)

    # Step 2: Generate grid
    grid_points = generate_grid(BBOX_CITY, GRID_SPACING_M)

    # Step 3: Analyse gaps
    gap_features, per_type_stats = analyse_gaps(grid_points, facilities)

    # Step 4: Cluster gap zones
    clusters = identify_gap_clusters(gap_features)
    log.info("Identified %d gap clusters across all service types", len(clusters))

    # Step 5: Write outputs
    write_gap_geojson(gap_features, GAPS_OUTPUT)
    write_summary(per_type_stats, clusters, SUMMARY_OUTPUT)

    # Final summary
    log.info("=== Coverage Summary ===")
    for stype, stats in per_type_stats.items():
        log.info("  %-15s %6.1f%% covered  (%d facilities, norm %dm)",
                 stype, stats["coverage_pct"], stats["facility_count"],
                 stats["norm_m"])

    log.info("Done.")


if __name__ == "__main__":
    main()
