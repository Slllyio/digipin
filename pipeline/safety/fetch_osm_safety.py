"""Fetch law-and-order / emergency-access reference points from OSM via Overpass.

For the Law & Order Mobility (access-resilience) layer — helping authorities and
emergency planners see where force/ambulance movement can be choked or sealed.
Fetches two kinds of points:

  * **police stations** (amenity=police) — for response-reach.
  * **movement chokepoints** that throttle a road: railway level crossings
    (trains halt road traffic and are easily sealed), toll booths, and lift
    gates. (Plain compound `gate`s are excluded — overwhelmingly private and not
    movement chokepoints.)

Writes data/vectors/osm_safety_<region>.geojson (Point features, `kind` tag).
Self-contained Overpass client (mirrors fetch_osm_roads.py). Defensive use:
identifies access vulnerabilities to keep them open, see docs/MOBILITY_MODEL.md.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

from pipeline._lib.regions import bbox_for, get_default_region_name

log = logging.getLogger("pipeline.safety.fetch_osm_safety")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "DigiPinDigitalTwin/1.0 (research)"


def _overpass_query(query, retries=3):
    """POST a query to Overpass with retry/back-off on 429s and timeouts; return JSON."""
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


def _classify(tags):
    """Map OSM tags to a safety feature category (police/level_crossing/barrier) or None."""
    if tags.get("amenity") == "police":
        return "police"
    if tags.get("railway") == "level_crossing":
        return "level_crossing"
    if tags.get("barrier") in ("toll_booth", "lift_gate"):
        return tags["barrier"]
    return None


def _to_features(elements):
    """Convert Overpass elements into classified GeoJSON Point features."""
    feats = []
    for el in elements:
        lat = el.get("lat")
        lng = el.get("lon")
        if lat is None and el.get("center"):
            lat, lng = el["center"]["lat"], el["center"]["lon"]
        if lat is None or lng is None:
            continue
        kind = _classify(el.get("tags", {}))
        if not kind:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {"osm_id": el.get("id"), "kind": kind,
                           "name": el.get("tags", {}).get("name", "")},
        })
    return feats


def fetch(region=None):
    """Query Overpass for police + chokepoints → write the geojson. Returns path."""
    region = region or get_default_region_name()
    w, s, e, n = bbox_for(region)          # bbox matches the output region name
    bbox = f"{s},{w},{n},{e}"
    query = f"""
    [out:json][timeout:120];
    (
      node["amenity"="police"]({bbox});
      way["amenity"="police"]({bbox});
      node["railway"="level_crossing"]({bbox});
      node["barrier"~"^(toll_booth|lift_gate)$"]({bbox});
    );
    out tags center;
    """
    log.info("querying Overpass for police + chokepoints in %s …", region)
    feats = _to_features(_overpass_query(query).get("elements", []))
    out = Path(f"data/vectors/osm_safety_{region}.geojson")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")))
    from collections import Counter
    kinds = Counter(f["properties"]["kind"] for f in feats)
    log.info("wrote %s — %d features %s", out, len(feats), dict(kinds))
    return out


def main():
    """CLI: fetch the region's OSM safety features from Overpass and write geojson."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    argparse.ArgumentParser().parse_args()
    fetch()


if __name__ == "__main__":
    main()
