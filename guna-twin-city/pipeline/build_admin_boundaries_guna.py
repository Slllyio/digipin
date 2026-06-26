"""Regenerate osm_admin_boundaries_guna.geojson with REAL Guna boundaries.

The committed file was wrong-geography (geocoding matched "Laguna" in Guatemala,
not "Guna" in Madhya Pradesh), so the Digital-Twin "Admin Zones" layer and the
strategic-twin Ward Dashboard were rendering / sampling the wrong continent.

This pulls administrative relations (tahsil/municipality/village-ward, admin_level
6/8/9) for the actual Guna bbox from Overpass, stitches each relation's outer ways
into polygons with shapely, and writes a clean GeoJSON the frontend consumes.

Run:  python guna-twin-city/pipeline/build_admin_boundaries_guna.py
"""
from __future__ import annotations

import json
from pathlib import Path

import requests
from shapely.geometry import LineString, mapping
from shapely.ops import polygonize, unary_union

# Real Guna metro bbox (south, west, north, east) — slightly padded.
BBOX = (24.55, 77.22, 24.73, 77.43)
OUT = Path(__file__).resolve().parent.parent / "data" / "vectors" / "osm_admin_boundaries_guna.geojson"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
HEADERS = {"User-Agent": "DigiPin-UrbanIntelligence/1.0 (admin-boundary build)"}


def _query():
    s, w, n, e = BBOX
    return f"""[out:json][timeout:60];
(
  relation["boundary"="administrative"]["admin_level"~"^(6|8|9)$"]({s},{w},{n},{e});
);
out geom;"""


def _fetch():
    last = None
    for url in ENDPOINTS:
        try:
            r = requests.post(url, data={"data": _query()}, headers=HEADERS, timeout=90)
            if r.status_code == 200:
                return r.json()
            last = f"{url} -> HTTP {r.status_code}"
        except Exception as ex:  # network/parse — try the next mirror
            last = f"{url} -> {ex!r}"
    raise SystemExit(f"Overpass fetch failed: {last}")


def _relation_polygon(el):
    """Stitch a relation's outer ways into a (multi)polygon geometry, or None."""
    lines = []
    for m in el.get("members", []):
        if m.get("type") != "way" or m.get("role") not in ("outer", ""):
            continue
        geom = m.get("geometry")
        if not geom or len(geom) < 2:
            continue
        lines.append(LineString([(p["lon"], p["lat"]) for p in geom]))
    if not lines:
        return None
    # polygonize closes the noded line network into faces; union merges them.
    polys = list(polygonize(unary_union(lines)))
    if not polys:
        return None
    merged = unary_union(polys)
    return mapping(merged)


def main():
    data = _fetch()
    feats = []
    for el in data.get("elements", []):
        geom = _relation_polygon(el)
        if not geom:
            continue
        tags = el.get("tags", {})
        feats.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "name": tags.get("name:en") or tags.get("name") or f"Ward {el.get('id')}",
                "name_local": tags.get("name"),
                "admin_level": tags.get("admin_level"),
            },
        })
    if not feats:
        raise SystemExit("no admin relations returned for the Guna bbox")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
    levels = {}
    for f in feats:
        lv = f["properties"]["admin_level"]
        levels[lv] = levels.get(lv, 0) + 1
    print(f"wrote {OUT} : {len(feats)} features, admin_levels={levels}")
    print("sample:", [f["properties"]["name"] for f in feats[:8]])


if __name__ == "__main__":
    main()
