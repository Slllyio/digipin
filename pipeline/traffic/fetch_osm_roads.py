"""Fetch the OSM arterial road network for the active region via Overpass.

Writes data/vectors/osm_roads_<region>.geojson — the input
`pipeline.traffic.road_network` expects. We query only the **arterial** classes
(motorway/trunk/primary/secondary/tertiary + their _link ramps): that keeps the
graph tractable and the committed GeoJSON small/browser-fetchable, and arterials
are where structural through-traffic (betweenness) concentrates.

Self-contained Overpass client (the helpers in pipeline/download_vectors.py pull
in shapely, which this step doesn't need).

Usage:
    python -m pipeline.traffic.fetch_osm_roads            # active region (DIGIPIN_REGION)
    python -m pipeline.traffic.fetch_osm_roads --classes primary secondary
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

from pipeline._lib.regions import bbox_for, get_default_region_name

log = logging.getLogger("pipeline.traffic.fetch_osm_roads")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "DigiPinDigitalTwin/1.0 (research)"
ARTERIAL = ["motorway", "trunk", "primary", "secondary", "tertiary"]


def _highway_regex(classes):
    """Overpass regex for the given base classes plus their _link ramps."""
    parts = []
    for c in classes:
        parts.append(c)
        parts.append(f"{c}_link")
    return "^(" + "|".join(parts) + ")$"


def _overpass_query(query, retries=3):
    """POST an Overpass QL query with retry/backoff on rate limits + timeouts."""
    import requests
    for attempt in range(retries):
        try:
            resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=300,
                                 headers={"User-Agent": USER_AGENT})
            if resp.status_code == 429 and attempt < retries - 1:
                wait = 30 * (attempt + 1)
                log.warning("rate limited, waiting %ds…", wait)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout:
            if attempt < retries - 1:
                wait = 30 * (attempt + 1)
                log.warning("timeout, retrying in %ds…", wait)
                time.sleep(wait)
            else:
                raise
    raise RuntimeError("Overpass query failed without returning data")


def _ways_to_lines(elements):
    """Convert Overpass way elements (with geometry) to LineString features."""
    feats = []
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        coords = [(pt["lon"], pt["lat"]) for pt in el["geometry"]]
        if len(coords) < 2:
            continue
        tags = el.get("tags", {})
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"osm_id": el["id"], "highway": tags.get("highway"),
                           "name": tags.get("name", "")},
        })
    return feats


def fetch(region=None, classes=None):
    """Query Overpass for the region's arterial roads → write the geojson. Returns path."""
    region = region or get_default_region_name()
    w, s, e, n = bbox_for(region)          # bbox matches the output region name
    bbox = f"{s},{w},{n},{e}"          # Overpass order: south,west,north,east
    rx = _highway_regex(classes or ARTERIAL)
    query = f"""
    [out:json][timeout:300][bbox:{bbox}];
    (way["highway"~"{rx}"];);
    out body geom;
    """
    log.info("querying Overpass for %s roads in %s …", rx, region)
    data = _overpass_query(query)
    feats = _ways_to_lines(data.get("elements", []))

    out = Path(f"data/vectors/osm_roads_{region}.geojson")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")))
    log.info("wrote %s — %d road segments (%.2f MB)",
             out, len(feats), out.stat().st_size / 1e6)
    return out


def main():
    """CLI: fetch the region's OSM road network from Overpass and write geojson."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--classes", nargs="*", default=None,
                    help=f"OSM highway base classes (default: {' '.join(ARTERIAL)})")
    args = ap.parse_args()
    fetch(classes=args.classes)


if __name__ == "__main__":
    main()
