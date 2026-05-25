"""
DigiPin Digital Twin — Vector Data Downloads (Guna)
====================================================
Downloads buildings, roads, POIs, water, railways, admin boundaries, green spaces
for Guna from OpenStreetMap via Overpass API.

Usage:
    python download_vectors.py                    # download all
    python download_vectors.py --layer buildings  # download specific layer
    python download_vectors.py --list             # list available layers

Requires: pip install requests shapely
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import requests

from config import BBOX, CITY_NAME

OUT_DIR = Path(__file__).parent.parent / "data" / "vectors"
OUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("vectors")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
BBOX_STR = f"{BBOX['south']},{BBOX['west']},{BBOX['north']},{BBOX['east']}"
USER_AGENT = "DigiPinDigitalTwin/1.0 (research)"


def _overpass_query(query: str, retries: int = 3) -> dict:
    """Execute Overpass QL query with retry and rate limiting."""
    for attempt in range(retries):
        try:
            resp = requests.post(
                OVERPASS_URL,
                data={"data": query},
                timeout=300,
                headers={"User-Agent": USER_AGENT},
            )
            if resp.status_code == 429:
                wait = 30 * (attempt + 1)
                log.warning("Rate limited, waiting %ds...", wait)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout:
            if attempt < retries - 1:
                wait = 30 * (attempt + 1)
                log.warning("Timeout, retrying in %ds...", wait)
                time.sleep(wait)
            else:
                raise
    return {}


def _ways_to_features(elements: list, as_polygon: bool = True) -> list:
    """Convert Overpass way elements to GeoJSON features."""
    features = []
    for el in elements:
        if el["type"] == "node":
            lat, lon = el.get("lat"), el.get("lon")
            if el.get("center"):
                lat, lon = el["center"]["lat"], el["center"]["lon"]
            if lat is None:
                continue
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {**el.get("tags", {}), "osm_id": el["id"]},
            })
        elif el["type"] == "way" and "geometry" in el:
            coords = [(pt["lon"], pt["lat"]) for pt in el["geometry"]]
            if len(coords) < 2:
                continue
            if as_polygon and len(coords) >= 4 and coords[0] == coords[-1]:
                geom = {"type": "Polygon", "coordinates": [coords]}
            else:
                geom = {"type": "LineString", "coordinates": coords}
            features.append({
                "type": "Feature",
                "geometry": geom,
                "properties": {**el.get("tags", {}), "osm_id": el["id"]},
            })
    return features


def _save_geojson(features: list, filename: str) -> Path:
    """Save GeoJSON feature collection."""
    out_path = OUT_DIR / filename
    geojson = {"type": "FeatureCollection", "features": features}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f)
    log.info("Saved: %s (%d features)", filename, len(features))
    return out_path


# --- Layer Downloaders ---

def download_buildings() -> Path:
    query = f"""[out:json][timeout:300][bbox:{BBOX_STR}];(way["building"];);out body geom;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", []), True), f"osm_buildings_{CITY_NAME}.geojson")

def download_roads() -> Path:
    query = f"""[out:json][timeout:300][bbox:{BBOX_STR}];(way["highway"];);out body geom;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", []), False), f"osm_roads_{CITY_NAME}.geojson")

def download_pois() -> Path:
    categories = [
        'hospital|clinic|pharmacy|doctors', 'school|college|university|library',
        'police|fire_station|post_office|townhall', 'bank|atm',
        'restaurant|cafe|fast_food', 'place_of_worship', 'fuel|bus_station',
    ]
    regex = "|".join(categories)
    query = f"""[out:json][timeout:300][bbox:{BBOX_STR}];(node["amenity"~"{regex}"];way["amenity"~"{regex}"];);out center body;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", [])), f"osm_pois_{CITY_NAME}.geojson")

def download_water() -> Path:
    query = f"""[out:json][timeout:180][bbox:{BBOX_STR}];(way["waterway"~"river|stream|canal|drain"];way["natural"="water"];relation["natural"="water"];way["landuse"="reservoir"];);out body geom;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", [])), f"osm_water_{CITY_NAME}.geojson")

def download_railways() -> Path:
    query = f"""[out:json][timeout:180][bbox:{BBOX_STR}];(way["railway"~"rail|light_rail|subway"];node["railway"~"station|halt"];);out body geom;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", []), False), f"osm_railways_{CITY_NAME}.geojson")

def download_green_spaces() -> Path:
    query = f"""[out:json][timeout:300][bbox:{BBOX_STR}];(way["leisure"~"park|garden|nature_reserve"];way["landuse"~"forest|grass|meadow|farmland|recreation_ground"];way["natural"~"wood|scrub|grassland"];);out body geom;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", [])), f"osm_green_spaces_{CITY_NAME}.geojson")

def download_admin_boundaries() -> Path:
    query = f"""[out:json][timeout:180];(relation["admin_level"="6"]["name"~"Guna",i];relation["admin_level"~"8|9|10"]["boundary"="administrative"]({BBOX_STR}););out body geom;"""
    data = _overpass_query(query)
    features = []
    for el in data.get("elements", []):
        if el["type"] != "relation":
            continue
        coords = []
        for member in el.get("members", []):
            if member.get("role") == "outer" and "geometry" in member:
                ring = [(pt["lon"], pt["lat"]) for pt in member["geometry"]]
                coords.extend(ring)
        if len(coords) >= 4:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": {**el.get("tags", {}), "osm_id": el["id"]},
            })
    return _save_geojson(features, f"osm_admin_boundaries_{CITY_NAME}.geojson")

def download_utilities() -> Path:
    query = f"""[out:json][timeout:180][bbox:{BBOX_STR}];(way["power"="line"];node["power"~"substation|tower|pole"];way["power"="substation"];node["man_made"~"mast|communications_tower|water_tower"];);out body geom;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", [])), f"osm_utilities_{CITY_NAME}.geojson")

def download_shops() -> Path:
    query = f"""[out:json][timeout:180][bbox:{BBOX_STR}];(node["shop"];way["shop"];way["landuse"="retail"];way["landuse"="commercial"];);out center body;"""
    data = _overpass_query(query)
    return _save_geojson(_ways_to_features(data.get("elements", [])), f"osm_shops_{CITY_NAME}.geojson")


# --- Layer Registry ---

LAYERS = {
    "buildings": ("Building Footprints", download_buildings),
    "roads": ("Road Network", download_roads),
    "pois": ("Points of Interest", download_pois),
    "water": ("Water Bodies & Rivers", download_water),
    "railways": ("Railway Lines & Stations", download_railways),
    "green": ("Green Spaces & Parks", download_green_spaces),
    "admin": ("Admin Boundaries & Wards", download_admin_boundaries),
    "utilities": ("Power & Telecom Infrastructure", download_utilities),
    "shops": ("Shops & Commercial", download_shops),
}


def main():
    parser = argparse.ArgumentParser(description="Download vector data for Guna Digital Twin")
    parser.add_argument("--layer", help="Download specific layer (see --list)")
    parser.add_argument("--list", action="store_true", help="List available layers")
    parser.add_argument("--all", action="store_true", help="Download all layers")
    args = parser.parse_args()

    if args.list:
        print("\nAvailable vector layers:")
        for key, (name, _) in LAYERS.items():
            print(f"  {key:15s} -- {name}")
        return

    if args.layer:
        if args.layer not in LAYERS:
            print(f"Unknown layer: {args.layer}. Use --list to see options.")
            return
        name, fn = LAYERS[args.layer]
        log.info("Downloading: %s", name)
        fn()
        return

    if args.all:
        results = {}
        for key, (name, fn) in LAYERS.items():
            try:
                fn()
                results[key] = "OK"
            except Exception as e:
                log.error("FAILED %s: %s", key, e)
                results[key] = f"FAILED: {e}"
            time.sleep(5)

        log.info("\n=== Download Summary ===")
        for key, status in results.items():
            log.info("  %s: %s", key, status)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
