"""Fetch OSM public-transit stops for the active region via Overpass.

Writes data/vectors/osm_transit_<region>.geojson (Point features). India has no
open GTFS feed for most city-bus operators (Indore/AICTSL included — its portal
publishes route/timing web pages but no GTFS, and Chalo's data is proprietary),
so OSM-mapped stops are the only openly-licensed transit signal available. This
yields a **coverage** signal (where transit is reachable), not timetable
frequency — see osm_transit.py and docs/TRAFFIC_MODEL.md.

Self-contained Overpass client (mirrors fetch_osm_roads.py).

Usage:
    python -m pipeline.traffic.fetch_osm_transit       # active region (DIGIPIN_REGION)
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

from pipeline._lib.regions import bbox_for, get_default_region_name

log = logging.getLogger("pipeline.traffic.fetch_osm_transit")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "DigiPinDigitalTwin/1.0 (research)"


def _overpass_query(query, retries=3):
    """POST an Overpass QL query with retry/backoff on rate limits + timeouts."""
    import requests
    for attempt in range(retries):
        try:
            resp = requests.post(OVERPASS_URL, data={"data": query}, timeout=180,
                                 headers={"User-Agent": USER_AGENT})
            if resp.status_code == 429 and attempt < retries - 1:
                time.sleep(30 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout:
            if attempt < retries - 1:
                time.sleep(30 * (attempt + 1))
            else:
                raise
    raise RuntimeError("Overpass query failed without returning data")


def _stops_to_features(elements):
    """Convert Overpass elements to transit-stop Point features (use center for ways)."""
    feats = []
    for el in elements:
        lat = el.get("lat")
        lng = el.get("lon")
        if lat is None and el.get("center"):
            lat, lng = el["center"]["lat"], el["center"]["lon"]
        if lat is None or lng is None:
            continue
        tags = el.get("tags", {})
        kind = (tags.get("amenity") == "bus_station" and "bus_station") \
            or tags.get("highway") or tags.get("public_transport") or "stop"
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {"osm_id": el.get("id"), "name": tags.get("name", ""), "kind": kind},
        })
    return feats


def fetch(region=None):
    """Query Overpass for the region's transit stops → write the geojson. Returns path."""
    region = region or get_default_region_name()
    w, s, e, n = bbox_for(region)          # bbox matches the output region name
    bbox = f"{s},{w},{n},{e}"
    query = f"""
    [out:json][timeout:120];
    (
      node["highway"="bus_stop"]({bbox});
      node["amenity"="bus_station"]({bbox});
      way["amenity"="bus_station"]({bbox});
      node["public_transport"="platform"]({bbox});
      node["public_transport"="station"]({bbox});
    );
    out tags center;
    """
    log.info("querying Overpass for transit stops in %s …", region)
    data = _overpass_query(query)
    feats = _stops_to_features(data.get("elements", []))
    out = Path(f"data/vectors/osm_transit_{region}.geojson")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")))
    log.info("wrote %s — %d transit stops", out, len(feats))
    return out


def main():
    """CLI: fetch the region's OSM transit stops from Overpass and write geojson."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    argparse.ArgumentParser().parse_args()
    fetch()


if __name__ == "__main__":
    main()
