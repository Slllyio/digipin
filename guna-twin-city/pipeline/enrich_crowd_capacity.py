"""
Enrich Road GeoJSON with Crowd Capacity Data & Download Sensitive Infrastructure
=================================================================================
Part 1: Compute width, lanes, flow, standing capacity, chokepoints per road segment
Part 2: Download places of worship, markets, schools, hospitals, police, fire, transport
Part 3: Generate crowd_analysis_summary.json

Usage:
    python enrich_crowd_capacity.py
    python enrich_crowd_capacity.py --skip-overpass
"""

import argparse
import json
import logging
import math
import sys
import urllib.request
import urllib.error
import urllib.parse
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

# IRC (Indian Roads Congress) standard width lookup in metres
IRC_WIDTH = {
    "trunk": 12,
    "trunk_link": 8,
    "primary": 9,
    "primary_link": 6,
    "secondary": 7,
    "secondary_link": 5,
    "tertiary": 5.5,
    "tertiary_link": 4,
    "residential": 5,
    "unclassified": 4,
    "living_street": 4,
    "service": 3,
    "track": 3,
    "footway": 1.5,
    "cycleway": 2,
    "path": 1.5,
    "pedestrian": 3,
    "steps": 1.5,
}

EARTH_RADIUS_M = 6_371_000

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT = 120  # seconds


# ---------------------------------------------------------------------------
# Geometry helpers (stdlib only — no shapely/geopandas)
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


def linestring_length(coords):
    """Compute geodesic length of a LineString coordinate list in metres."""
    total = 0.0
    for i in range(len(coords) - 1):
        total += haversine(coords[i][0], coords[i][1],
                           coords[i + 1][0], coords[i + 1][1])
    return total


def multilinestring_length(coord_lists):
    """Compute geodesic length of a MultiLineString in metres."""
    return sum(linestring_length(c) for c in coord_lists)


def geometry_length(geom):
    """Return length in metres for LineString or MultiLineString."""
    gtype = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if gtype == "LineString":
        return linestring_length(coords)
    if gtype == "MultiLineString":
        return multilinestring_length(coords)
    return 0.0


def geometry_midpoint(geom):
    """Return approximate midpoint (lon, lat) of a line geometry."""
    gtype = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if gtype == "MultiLineString":
        # flatten
        coords = [pt for seg in coords for pt in seg]
    if not coords:
        return (0, 0)
    mid = coords[len(coords) // 2]
    return (mid[0], mid[1])


def parse_numeric(val):
    """Try to parse a numeric value from an OSM tag string."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    # strip units like "5 m" or "5m"
    cleaned = val.strip().rstrip("m").strip()
    try:
        return float(cleaned)
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Part 1 — Road Capacity Enrichment
# ---------------------------------------------------------------------------

def estimate_width(props):
    """Return estimated road width in metres."""
    # Priority 1: explicit width tag
    w = parse_numeric(props.get("width"))
    if w is not None and w > 0:
        return w

    # Priority 2: lanes tag -> width
    lanes_val = parse_numeric(props.get("lanes"))
    if lanes_val is not None and lanes_val > 0:
        return lanes_val * 3.5

    # Priority 3: IRC lookup by highway type
    hw = props.get("highway", "")
    return IRC_WIDTH.get(hw, 4.0)


def crowd_risk_label(width):
    """Classify crowd risk based on effective width."""
    if width >= 7:
        return "low"
    if width >= 4:
        return "medium"
    if width >= 2:
        return "high"
    return "critical"


def enrich_roads(input_path, output_path):
    """Read road GeoJSON, compute crowd-capacity properties, write enriched file."""
    log.info("Reading road GeoJSON from %s", input_path)
    with open(input_path, encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features", [])
    log.info("Loaded %d road features", len(features))

    # Build a width index for chokepoint detection (osm_id -> width)
    width_index = {}
    # Build adjacency: endpoint -> list of osm_ids that touch it
    endpoint_adj = {}

    # First pass: compute widths and build adjacency
    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        osm_id = props.get("osm_id", id(feat))
        w = estimate_width(props)
        width_index[osm_id] = w

        coords = geom.get("coordinates", [])
        gtype = geom.get("type", "")
        endpoints = []
        if gtype == "LineString" and len(coords) >= 2:
            endpoints = [tuple(coords[0][:2]), tuple(coords[-1][:2])]
        elif gtype == "MultiLineString":
            for seg in coords:
                if len(seg) >= 2:
                    endpoints.append(tuple(seg[0][:2]))
                    endpoints.append(tuple(seg[-1][:2]))

        for ep in endpoints:
            # Round to ~1m precision for matching
            key = (round(ep[0], 5), round(ep[1], 5))
            endpoint_adj.setdefault(key, []).append(osm_id)

    # Build neighbour width lookup: osm_id -> set of neighbour osm_ids
    neighbours = {}
    for ep_ids in endpoint_adj.values():
        for oid in ep_ids:
            for other in ep_ids:
                if other != oid:
                    neighbours.setdefault(oid, set()).add(other)

    # Second pass: enrich each feature
    stats_length_by_type = {}
    chokepoints = []
    all_segments = []

    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        osm_id = props.get("osm_id", id(feat))
        hw = props.get("highway", "unknown")

        length_m = geometry_length(geom)
        width_m = width_index.get(osm_id, 4.0)
        lanes_est = max(1, round(width_m / 3.5))
        effective_width = max(1.0, width_m - 1.0)
        max_flow_ppm = effective_width * 1.2 * 60
        capacity_standing = length_m * effective_width * 4
        risk = crowd_risk_label(width_m)

        # Chokepoint: narrow segment (<4m) connecting to wider segments (>6m)
        is_chokepoint = False
        if width_m < 4:
            nbr_ids = neighbours.get(osm_id, set())
            for nid in nbr_ids:
                if width_index.get(nid, 0) > 6:
                    is_chokepoint = True
                    break

        # Write enriched properties
        props["width_m"] = round(width_m, 2)
        props["lanes_est"] = lanes_est
        props["effective_width_m"] = round(effective_width, 2)
        props["max_flow_ppm"] = round(max_flow_ppm, 1)
        props["capacity_standing"] = round(capacity_standing, 0)
        props["length_m"] = round(length_m, 2)
        props["crowd_risk"] = risk
        props["is_chokepoint"] = is_chokepoint

        # Accumulate stats
        stats_length_by_type[hw] = stats_length_by_type.get(hw, 0) + length_m

        if is_chokepoint:
            mid = geometry_midpoint(geom)
            chokepoints.append({
                "osm_id": osm_id,
                "lat": round(mid[1], 6),
                "lng": round(mid[0], 6),
                "width_m": round(width_m, 2),
                "length_m": round(length_m, 2),
                "name": props.get("name", ""),
            })

        all_segments.append({
            "osm_id": osm_id,
            "highway": hw,
            "width_m": round(width_m, 2),
            "length_m": round(length_m, 2),
            "name": props.get("name", ""),
            "lat": round(geometry_midpoint(geom)[1], 6),
            "lng": round(geometry_midpoint(geom)[0], 6),
        })

    # Write enriched GeoJSON
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    log.info("Wrote enriched GeoJSON to %s", output_path)

    # Print summary
    total_length_km = sum(stats_length_by_type.values()) / 1000
    log.info("=== Road Capacity Summary ===")
    log.info("Total road length: %.1f km", total_length_km)
    log.info("Chokepoints detected: %d", len(chokepoints))
    log.info("Road length by type:")
    for hw, length in sorted(stats_length_by_type.items(),
                             key=lambda x: -x[1]):
        log.info("  %-20s %8.1f m  (%5.1f km)", hw, length, length / 1000)

    return {
        "length_by_type": {
            k: round(v, 1) for k, v in stats_length_by_type.items()
        },
        "chokepoints": chokepoints,
        "all_segments": all_segments,
    }


# ---------------------------------------------------------------------------
# Part 2 — Sensitive Infrastructure Download
# ---------------------------------------------------------------------------

OVERPASS_QUERIES = {
    "worship": '[out:json][timeout:{timeout}];(node["amenity"="place_of_worship"]({bbox});way["amenity"="place_of_worship"]({bbox}););out center;',
    "market": '[out:json][timeout:{timeout}];(node["amenity"="marketplace"]({bbox});way["amenity"="marketplace"]({bbox});node["shop"="supermarket"]({bbox});way["shop"="supermarket"]({bbox});node["landuse"="commercial"]({bbox});way["landuse"="commercial"]({bbox}););out center;',
    "school": '[out:json][timeout:{timeout}];(node["amenity"="school"]({bbox});way["amenity"="school"]({bbox}););out center;',
    "hospital": '[out:json][timeout:{timeout}];(node["amenity"="hospital"]({bbox});way["amenity"="hospital"]({bbox});node["amenity"="clinic"]({bbox});way["amenity"="clinic"]({bbox}););out center;',
    "police": '[out:json][timeout:{timeout}];(node["amenity"="police"]({bbox});way["amenity"="police"]({bbox}););out center;',
    "fire_station": '[out:json][timeout:{timeout}];(node["amenity"="fire_station"]({bbox});way["amenity"="fire_station"]({bbox}););out center;',
    "transport": '[out:json][timeout:{timeout}];(node["amenity"="bus_station"]({bbox});way["amenity"="bus_station"]({bbox});node["public_transport"="station"]({bbox});way["public_transport"="station"]({bbox}););out center;',
}

RELIGION_CATEGORY_MAP = {
    "hindu": "worship_hindu",
    "muslim": "worship_muslim",
    "islam": "worship_muslim",
    "jain": "worship_jain",
    "sikh": "worship_sikh",
    "christian": "worship_christian",
    "christianity": "worship_christian",
}


def overpass_bbox_str(bbox):
    """Format bbox as south,west,north,east for Overpass QL."""
    return f"{bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']}"


def query_overpass(query_template, bbox, timeout=OVERPASS_TIMEOUT):
    """Execute an Overpass API query and return parsed JSON."""
    bbox_str = overpass_bbox_str(bbox)
    query = query_template.format(bbox=bbox_str, timeout=timeout)
    post_data = urllib.parse.urlencode({"data": query}).encode("utf-8")

    req = urllib.request.Request(
        OVERPASS_URL,
        data=post_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=timeout + 30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def element_to_point(elem):
    """Extract (lon, lat) from an Overpass element (node or way with center)."""
    if elem.get("type") == "node":
        return (elem.get("lon", 0), elem.get("lat", 0))
    # way/relation with 'center' output
    center = elem.get("center", {})
    return (center.get("lon", 0), center.get("lat", 0))


def classify_worship(tags):
    """Return worship sub-category from religion tag."""
    religion = (tags.get("religion", "") or "").strip().lower()
    return RELIGION_CATEGORY_MAP.get(religion, "worship_other")


def download_infrastructure(bbox, output_path):
    """Query Overpass for sensitive infrastructure, write GeoJSON."""
    features = []
    counts = {}

    for cat_key, query_tpl in OVERPASS_QUERIES.items():
        log.info("Querying Overpass for: %s", cat_key)
        try:
            result = query_overpass(query_tpl, bbox)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            log.error("Overpass query failed for %s: %s", cat_key, exc)
            continue

        elements = result.get("elements", [])
        log.info("  Received %d elements for %s", len(elements), cat_key)

        for elem in elements:
            tags = elem.get("tags", {})
            lon, lat = element_to_point(elem)
            if lon == 0 and lat == 0:
                continue

            osm_id = elem.get("id", 0)
            name = tags.get("name", tags.get("name:en", ""))

            if cat_key == "worship":
                category = classify_worship(tags)
            else:
                category = cat_key

            props = {
                "category": category,
                "name": name,
                "osm_id": osm_id,
            }
            if cat_key == "worship":
                props["religion"] = tags.get("religion", "")

            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat],
                },
                "properties": props,
            }
            features.append(feature)
            counts[category] = counts.get(category, 0) + 1

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    log.info("Wrote %d infrastructure features to %s", len(features), output_path)

    log.info("=== Infrastructure Counts ===")
    for cat, cnt in sorted(counts.items()):
        log.info("  %-25s %d", cat, cnt)

    return counts


# ---------------------------------------------------------------------------
# Part 3 — Summary JSON
# ---------------------------------------------------------------------------

def find_high_connectivity_intersections(endpoint_adj_data, width_index, top_n=20):
    """Find intersections (endpoints) with highest connectivity."""
    # Rebuild endpoint adjacency from enriched data
    # endpoint_adj_data is passed from Part 1 context
    scored = []
    for ep_key, osm_ids in endpoint_adj_data.items():
        if len(osm_ids) >= 3:
            avg_width = sum(width_index.get(oid, 4) for oid in osm_ids) / len(osm_ids)
            scored.append({
                "lat": ep_key[1],
                "lng": ep_key[0],
                "connections": len(osm_ids),
                "avg_width_m": round(avg_width, 2),
            })
    scored.sort(key=lambda x: -x["connections"])
    return scored[:top_n]


def build_summary(road_stats, infra_counts, input_path):
    """Build and return the crowd analysis summary dict."""
    # Re-read the enriched data to get endpoint adjacency for intersections
    # We rebuild it here to keep Part 1 clean
    with open(input_path, encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features", [])
    endpoint_adj = {}
    width_index = {}

    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        osm_id = props.get("osm_id", id(feat))
        width_index[osm_id] = props.get("width_m", 4.0)

        coords = geom.get("coordinates", [])
        gtype = geom.get("type", "")
        endpoints = []
        if gtype == "LineString" and len(coords) >= 2:
            endpoints = [tuple(coords[0][:2]), tuple(coords[-1][:2])]
        elif gtype == "MultiLineString":
            for seg in coords:
                if len(seg) >= 2:
                    endpoints.append(tuple(seg[0][:2]))
                    endpoints.append(tuple(seg[-1][:2]))

        for ep in endpoints:
            key = (round(ep[0], 5), round(ep[1], 5))
            endpoint_adj.setdefault(key, []).append(osm_id)

    # Top 20 narrowest segments
    narrowest = sorted(road_stats["all_segments"], key=lambda s: s["width_m"])[:20]

    # Key intersections
    intersections = find_high_connectivity_intersections(endpoint_adj, width_index)

    summary = {
        "city": CITY_NAME,
        "total_road_length_km": round(
            sum(road_stats["length_by_type"].values()) / 1000, 2
        ),
        "road_length_by_type_m": road_stats["length_by_type"],
        "chokepoint_count": len(road_stats["chokepoints"]),
        "chokepoints": road_stats["chokepoints"],
        "top_20_narrowest_segments": narrowest,
        "infrastructure_counts": infra_counts or {},
        "key_intersections": intersections,
    }
    return summary


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Enrich road GeoJSON with crowd capacity & download sensitive infrastructure"
    )
    parser.add_argument(
        "--skip-overpass",
        action="store_true",
        help="Skip Part 2 (Overpass download) if the API is unavailable",
    )
    args = parser.parse_args()

    input_roads = VECTOR_DIR / f"osm_roads_{CITY_NAME}.geojson"
    output_roads = VECTOR_DIR / f"roads_crowd_capacity_{CITY_NAME}.geojson"
    output_infra = VECTOR_DIR / f"sensitive_infrastructure_{CITY_NAME}.geojson"
    output_summary = VECTOR_DIR / "crowd_analysis_summary.json"

    if not input_roads.exists():
        log.error("Input road file not found: %s", input_roads)
        sys.exit(1)

    # --- Part 1: Road Capacity ---
    log.info("=== Part 1: Road Capacity Enrichment ===")
    road_stats = enrich_roads(input_roads, output_roads)

    # --- Part 2: Sensitive Infrastructure ---
    infra_counts = {}
    if args.skip_overpass:
        log.info("=== Part 2: Skipped (--skip-overpass) ===")
    else:
        log.info("=== Part 2: Sensitive Infrastructure Download ===")
        infra_counts = download_infrastructure(BBOX_CITY, output_infra)

    # --- Part 3: Summary JSON ---
    log.info("=== Part 3: Summary JSON ===")
    summary = build_summary(road_stats, infra_counts, output_roads)
    output_summary.parent.mkdir(parents=True, exist_ok=True)
    with open(output_summary, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    log.info("Wrote summary to %s", output_summary)

    log.info("Done.")


if __name__ == "__main__":
    main()
