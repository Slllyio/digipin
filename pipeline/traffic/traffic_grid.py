"""Bin the scored road network into a small per-cell traffic grid.

Takes `data/traffic/<region>/road_los.geojson` (from `road_network.py`) and
aggregates road segments onto a regular grid over the region bbox — the same
footprint-grid JSON shape the browser already knows how to sample
(`js/footprint-grid.js`). The browser reads one small file and samples per
DigiPin cell, so the cell panel can show the local congestion grade without any
per-click network call.

Output:
    data/traffic/<region>/traffic_grid.json
    { res_m, bounds:{w,s,e,n}, nx, ny,
      congestion_risk[], worst_los[], dominant_class[], road_density_m[],
      has_critical_link[], betweenness_max[],
      transit_access[]?, transit_stops[]?, transit_headway_min[]?  (added by gtfs_transit.py) }

`bin_segments` is pure (stdlib) and unit-tested; IO is thin.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
from pathlib import Path

from pipeline._lib.regions import get_default_bbox, get_default_region_name

log = logging.getLogger("pipeline.traffic.traffic_grid")

_LOS_RANK = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4, "F": 5}
_RANK_LOS = {v: k for k, v in _LOS_RANK.items()}
EARTH_RADIUS_M = 6_371_000


def _seg_points(geom):
    """Yield (lng, lat) vertices of a Line/MultiLineString geometry."""
    gtype, coords = geom.get("type", ""), geom.get("coordinates", [])
    if gtype == "LineString":
        yield from ((p[0], p[1]) for p in coords)
    elif gtype == "MultiLineString":
        for seg in coords:
            yield from ((p[0], p[1]) for p in seg)


def _length_m(geom):
    pts = list(_seg_points(geom))
    total = 0.0
    for i in range(len(pts) - 1):
        lon1, lat1 = pts[i]
        lon2, lat2 = pts[i + 1]
        rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
        a = (math.sin(math.radians(lat2 - lat1) / 2) ** 2
             + math.cos(rlat1) * math.cos(rlat2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
        total += EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return total


def _cell_of(lng, lat, bbox, nx, ny):
    w, s, e, n = bbox
    if not (w <= lng < e and s <= lat < n):
        return -1
    x = min(nx - 1, int((lng - w) / (e - w) * nx))
    y = min(ny - 1, int((n - lat) / (n - s) * ny))   # row 0 = north
    return y * nx + x


def bin_segments(features, bbox, res_m=200):
    """Bin road-LOS features onto a grid. Pure.

    Each segment is assigned to the cell of its midpoint vertex; per cell we keep
    the worst (max) congestion_risk / LOS, max betweenness, total road length,
    the dominant highway class, and whether any critical link passes through.
    Returns the footprint-grid JSON shape (row-major, y from north)."""
    w, s, e, n = bbox
    deg = res_m / 111_000.0
    nx = max(1, round((e - w) / deg))
    ny = max(1, round((n - s) / deg))
    size = nx * ny

    risk = [0] * size
    los_rank = [-1] * size
    betw = [0.0] * size
    density = [0.0] * size
    critical = [0] * size
    class_len = [None] * size   # dict highway->metres, lazily created

    for feat in features:
        geom = feat.get("geometry", {})
        props = feat.get("properties", {})
        pts = list(_seg_points(geom))
        if not pts:
            continue
        mlng, mlat = pts[len(pts) // 2]
        idx = _cell_of(mlng, mlat, bbox, nx, ny)
        if idx < 0:
            continue
        r = props.get("congestion_risk")
        if isinstance(r, (int, float)) and r > risk[idx]:
            risk[idx] = int(r)
        g = _LOS_RANK.get(props.get("los_grade"))
        if g is not None and g > los_rank[idx]:
            los_rank[idx] = g
        b = props.get("betweenness")
        if isinstance(b, (int, float)) and b > betw[idx]:
            betw[idx] = float(b)
        density[idx] += _length_m(geom)
        if props.get("criticality") == "critical":
            critical[idx] = 1
        hw = props.get("highway")
        if isinstance(hw, (list, tuple)):
            hw = hw[0] if hw else None
        if hw:
            if class_len[idx] is None:
                class_len[idx] = {}
            class_len[idx][hw] = class_len[idx].get(hw, 0.0) + _length_m(geom)

    worst_los = [(_RANK_LOS[r] if r >= 0 else None) for r in los_rank]
    dominant = [(max(cl, key=cl.get) if cl else None) for cl in class_len]
    return {
        "res_m": res_m,
        "bounds": {"west": w, "south": s, "east": e, "north": n},
        "nx": nx, "ny": ny,
        "congestion_risk": risk,
        "worst_los": worst_los,
        "dominant_class": dominant,
        "road_density_m": [round(d, 1) for d in density],
        "has_critical_link": critical,
        "betweenness_max": [round(b, 6) for b in betw],
        "source": "osm_betweenness_los",
    }


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=None, help="road_los.geojson")
    ap.add_argument("--res", type=int, default=200)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    region = get_default_region_name()
    bbox = get_default_bbox()
    inp = Path(args.inp) if args.inp else Path(f"data/traffic/{region}/road_los.geojson")
    if not inp.exists():
        raise SystemExit(f"missing {inp} — run pipeline.traffic.road_network first")
    gj = json.loads(inp.read_text())
    grid = bin_segments(gj.get("features", []), bbox, args.res)
    out = Path(args.out) if args.out else Path(f"data/traffic/{region}/traffic_grid.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(grid, separators=(",", ":")))
    log.info("wrote %s — %dx%d cells (%.2f KB)",
             out, grid["nx"], grid["ny"], out.stat().st_size / 1024)


if __name__ == "__main__":
    main()
