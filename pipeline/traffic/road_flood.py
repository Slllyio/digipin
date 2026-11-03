"""Which modelled roads go under water: waterlogging and river-flood flags per road.

Each arterial in data/traffic/<region>/road_los.geojson is sampled every
~SAMPLE_M along its length; every sample reads its L7 cell in the
`waterlogging` and `water` cell datasets. Written back onto the road:

    wlog   highest waterlogging index along the road (0–100; ≥ 65 "Very high",
           ≥ 45 "High", from pipeline/cells/ee_layers.py)
    wlog_hi  % of the road's samples in High-or-worse cells
    fl100  1 when some stretch sits in the 1-in-100-year river flood extent
           (JRC/GloFAS share ≥ 50%) at ≥ 0.3 m depth

js/road-whatif.js uses them for the monsoon what-if (slow or close these roads
and re-route the commute). Runs after demand_model (which rewrites the file
but keeps unknown properties).

    python -m pipeline.traffic.road_flood --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
LEVEL = 7
SAMPLE_M = 100.0
WLOG_HIGH, WLOG_VERY = 45, 65
FLOOD_SHARE, FLOOD_DEPTH = 50.0, 0.3


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def samples(coords, step_m=SAMPLE_M):
    """Points every ~step_m along a polyline (vertices included)."""
    out = []
    for (ax, ay), (bx, by) in zip(coords, coords[1:]):
        d = dm.haversine_m(ax, ay, bx, by)
        k = max(1, int(math.ceil(d / step_m)))
        for j in range(k):
            t = j / k
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
    if coords:
        out.append(tuple(coords[-1][:2]))
    return out


def road_flags(coords, wlog_at, flood_at):
    """{wlog, wlog_hi, fl100} for one road from lookups code → value (None when unknown)."""
    best, fl, hi, n = 0, 0, 0, 0
    for x, y in samples(coords):
        try:
            code = digipin.encode(y, x).replace("-", "")[:LEVEL]
        except Exception:
            continue
        w = wlog_at(code)
        n += 1
        if w is not None and w > best:
            best = w
        if w is not None and w >= WLOG_HIGH:
            hi += 1
        f = flood_at(code)
        if f:
            fl = 1
    return {"wlog": int(round(best)), "wlog_hi": round(100 * hi / n) if n else 0, "fl100": fl}


def _lines(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


# ── run ─────────────────────────────────────────────────────────────────────

def run(region, log=print):
    path = REPO / "data" / "traffic" / region / "road_los.geojson"
    if not path.exists():
        log(f"{region}: no road_los.geojson, skipped")
        return None
    wl, wa = dm._read("waterlogging", region), dm._read("water", region)
    wmap = dict(zip(wl.codes, wl.columns["waterlogging_index"])) if wl is not None else {}
    fmap = {}
    if wa is not None:
        for c, s, d in zip(wa.codes, wa.columns["flood_rp100_pct"], wa.columns["flood_rp100_depth_m"]):
            if s is not None and s >= FLOOD_SHARE and (d is None or d >= FLOOD_DEPTH):
                fmap[c] = True
    gj = json.loads(path.read_text())
    # high = at least half the road in High-or-worse cells (and not Very high anywhere)
    km = {"very_high": 0.0, "high": 0.0, "river_flood": 0.0, "total": 0.0}
    for f in gj["features"]:
        coords = [pt for line in _lines(f["geometry"]) for pt in line]
        fl = road_flags(coords, lambda c: wmap.get(c), lambda c: fmap.get(c, False))
        f["properties"].update(fl)
        L = sum(dm.haversine_m(*a[:2], *b[:2]) for line in _lines(f["geometry"]) for a, b in zip(line, line[1:])) / 1000
        km["total"] += L
        if fl["wlog"] >= WLOG_VERY:
            km["very_high"] += L
        elif fl["wlog_hi"] >= 50:
            km["high"] += L
        if fl["fl100"]:
            km["river_flood"] += L
    path.write_text(json.dumps(gj, separators=(",", ":")))
    summ = path.parent / "summary.json"
    s = json.loads(summ.read_text()) if summ.exists() else {}
    s["road_flood"] = {k: round(v, 1) for k, v in km.items()} | {
        "pct_very_high": round(100 * km["very_high"] / (km["total"] or 1), 1),
        "pct_high_or_worse": round(100 * (km["very_high"] + km["high"]) / (km["total"] or 1), 1)}
    summ.write_text(json.dumps(s, indent=2) + "\n")
    log(f"{region}: {json.dumps(s['road_flood'])}")
    return s["road_flood"]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
