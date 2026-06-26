"""Precompute deploy-ready assets for the Aino 3D twin (aino-twin.js).

Two problems this solves:
  1. The twin read the full 8.6 MB google_open_buildings_guna.geojson, which is
     gitignored → works locally, 404s on deploy. We emit a slimmed, committed
     buildings file (outer-ring geometry + area only, coords rounded).
  2. Trees only appeared in OSM green polygons (Guna's are peripheral). We add
     STREET trees sampled along the road network so the dense core looks alive.

Outputs (committed, served by the page):
  data/vectors/buildings_lite_guna.geojson   {geometry, properties:{area_m2}}
  data/vectors/aino_trees_guna.json          {"trees": [[lng,lat,scale], ...]}

Run:  python guna-twin-city/pipeline/build_aino_assets_guna.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from shapely.geometry import shape, Point

GUNA = Path(__file__).resolve().parents[1]
VEC = GUNA / "data" / "vectors"
BUILDINGS_IN = VEC / "google_open_buildings_guna.geojson"
GREEN_IN = VEC / "osm_green_spaces_guna.geojson"
ROADS_IN = VEC / "osm_roads_guna.geojson"
BUILDINGS_OUT = VEC / "buildings_lite_guna.geojson"
TREES_OUT = VEC / "aino_trees_guna.json"

# Guna metro core (lng/lat) — street trees only seeded here, where the demo looks.
CORE = (77.28, 24.60, 77.36, 24.69)            # w, s, e, n
STREET_STEP_M = 42.0                            # spacing of street trees along a road
STREET_OFFSET_M = 8.5                           # perpendicular offset from the centreline
MAX_STREET_TREES = 7000
# Road classes worth lining with trees (skip tiny service/footpaths).
STREET_CLASSES = {"primary", "secondary", "tertiary", "residential", "trunk",
                  "primary_link", "secondary_link", "unclassified", "living_street"}


def _round_ring(ring):
    return [[round(x, 5), round(y, 5)] for x, y in ring]


def slim_buildings():
    data = json.loads(BUILDINGS_IN.read_text(encoding="utf-8"))
    feats = []
    for f in data.get("features", []):
        g = f.get("geometry")
        if not g:
            continue
        polys = g["coordinates"] if g["type"] == "Polygon" else \
            (g["coordinates"][0] if g["type"] == "MultiPolygon" else None)
        ring = (polys[0] if g["type"] == "Polygon" else polys[0]) if polys else None
        if not ring or len(ring) < 4:
            continue
        area = round(float(f.get("properties", {}).get("area_m2") or 0), 1)
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [_round_ring(ring)]},
            "properties": {"area_m2": area},
        })
    BUILDINGS_OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                        separators=(",", ":")), encoding="utf-8")
    print(f"buildings_lite: {len(feats)} features, {BUILDINGS_OUT.stat().st_size//1024} KB")


def _mlng(lat):
    return 111320.0 * math.cos(math.radians(lat))


def green_trees():
    if not GREEN_IN.exists():
        return []
    data = json.loads(GREEN_IN.read_text(encoding="utf-8"))
    import random
    rng = random.Random(42)
    pts = []
    for f in data.get("features", []):
        geom = f.get("geometry")
        if not geom:
            continue
        try:
            poly = shape(geom)
        except Exception:
            continue
        mnx, mny, mxx, mxy = poly.bounds
        n = min(140, max(3, int((mxx - mnx) * (mxy - mny) * 6e6)))
        placed = tries = 0
        while placed < n and tries < n * 12:
            tries += 1
            px = rng.uniform(mnx, mxx)
            py = rng.uniform(mny, mxy)
            if poly.contains(Point(px, py)):
                pts.append([round(px, 5), round(py, 5), round(0.7 + rng.random() * 0.8, 2)])
                placed += 1
    print(f"green trees: {len(pts)}")
    return pts


def street_trees():
    if not ROADS_IN.exists():
        return []
    data = json.loads(ROADS_IN.read_text(encoding="utf-8"))
    import random
    rng = random.Random(7)
    w, s, e, n = CORE
    pts = []
    for f in data.get("features", []):
        if len(pts) >= MAX_STREET_TREES:
            break
        props = f.get("properties", {})
        klass = props.get("highway") or props.get("class") or props.get("fclass") or ""
        if klass not in STREET_CLASSES:
            continue
        geom = f.get("geometry")
        if not geom or geom.get("type") != "LineString":
            continue
        coords = geom["coordinates"]
        for i in range(len(coords) - 1):
            (x1, y1), (x2, y2) = coords[i], coords[i + 1]
            midy = (y1 + y2) / 2
            if not (w <= x1 <= e and s <= y1 <= n):
                continue
            mlng = _mlng(midy)
            dx = (x2 - x1) * mlng
            dy = (y2 - y1) * 111320.0
            seglen = math.hypot(dx, dy)
            if seglen < 1:
                continue
            # unit perpendicular (in degrees)
            ux, uy = dx / seglen, dy / seglen
            perp = (-uy / 111320.0, ux / mlng)        # (dlng, dlat) of the normal, ~1 m
            steps = int(seglen // STREET_STEP_M)
            for k in range(1, steps + 1):
                t = (k * STREET_STEP_M) / seglen
                bx = x1 + (x2 - x1) * t
                by = y1 + (y2 - y1) * t
                if rng.random() > 0.72:               # denser avenue
                    continue
                side = 1 if (k % 2 == 0) else -1
                tx = bx + perp[0] * STREET_OFFSET_M * side
                ty = by + perp[1] * STREET_OFFSET_M * side
                # taller than green-area trees so they peek above the low-rise blocks
                pts.append([round(tx, 5), round(ty, 5), round(1.1 + rng.random() * 0.6, 2)])
                if len(pts) >= MAX_STREET_TREES:
                    break
    print(f"street trees: {len(pts)}")
    return pts


def main():
    slim_buildings()
    trees = green_trees() + street_trees()
    TREES_OUT.write_text(json.dumps({"trees": trees}, separators=(",", ":")), encoding="utf-8")
    print(f"trees total: {len(trees)}, {TREES_OUT.stat().st_size//1024} KB")


if __name__ == "__main__":
    main()
