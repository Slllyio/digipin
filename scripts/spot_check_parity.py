"""Spot-check: precomputed feature counts vs live Overpass (A2 verification).

The feature counter (pipeline/scores/count_features.py) has known v1 deltas vs
the live app: relations (multipolygon parks/rivers/landuse) aren't counted, the
L8 binning quantizes positions, and the .pbf snapshot lags live OSM. This script
*measures* those deltas instead of assuming them — for N sample cells it counts
features two ways and reports the differences, flagging the relation-heavy
features where the gap is expected.

Needs network (Overpass) + the same .osm.pbf used to build the tile, so it runs
in CI or locally, not in the sandbox:

    python scripts/spot_check_parity.py --pbf indore.osm.pbf --n 20

The pure diff/summary logic (compare_counts, summarize) is unit-tested in
pipeline/scores/tests/test_spot_check.py; only the Overpass/pbf I/O needs the
network.
"""
from __future__ import annotations

import argparse
import sys
import time

# Features whose geometry is often a relation (multipolygon) or a large area —
# where the nodes+ways-only v1 counter is expected to under-count.
RELATION_HEAVY = frozenset({
    "parks", "garden", "nature_reserve", "water_body", "river",
    "residential_area", "commercial_area", "industrial_area", "retail_area",
    "farmland", "construction", "vacant", "cemetery", "military",
})

OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def overpass_query(lat: float, lng: float, radius: int = 400) -> str:
    """Mirror buildOverpassQuery (js/data-fetcher.js) for one point."""
    a = f"(around:{radius},{lat},{lng})"
    return f"""[out:json][timeout:60];(
  nwr[amenity]{a};
  nwr[shop]{a};
  nwr[tourism]{a};
  nwr[leisure]{a};
  nwr[office]{a};
  nwr[healthcare]{a};
  way[building]{a};
  way[landuse]{a};
  nwr[highway=bus_stop]{a};
  nwr[highway=street_lamp]{a};
  way[highway~"^(primary|secondary|tertiary|residential|trunk|footway|path|pedestrian|cycleway)$"]{a};
  nwr[man_made~"^(tower|mast|water_tower|storage_tank|bridge)$"]{a};
  nwr[power]{a};
  nwr[natural=water]{a};
  nwr[waterway]{a};
  nwr[railway~"^(station|halt)$"]{a};
  nwr[station=subway]{a};
  nwr[historic]{a};
);out center body;"""


def compare_counts(pre: dict, live: dict) -> list:
    """Per-feature rows (feature, precomputed, live, delta) for features in either."""
    rows = []
    for feat in sorted(set(pre) | set(live)):
        p, lv = pre.get(feat, 0), live.get(feat, 0)
        rows.append({"feature": feat, "pre": p, "live": lv, "delta": p - lv})
    return rows


def summarize(all_rows: list) -> dict:
    """Aggregate per-cell comparisons into a tolerance report."""
    total_abs = 0
    rel_abs = 0          # |delta| concentrated in relation-heavy features
    nonrel_abs = 0
    by_feature: dict[str, int] = {}
    for rows in all_rows:
        for r in rows:
            d = abs(r["delta"])
            total_abs += d
            by_feature[r["feature"]] = by_feature.get(r["feature"], 0) + d
            if r["feature"] in RELATION_HEAVY:
                rel_abs += d
            else:
                nonrel_abs += d
    worst = sorted(by_feature.items(), key=lambda kv: -kv[1])[:10]
    return {
        "cells": len(all_rows),
        "total_abs_delta": total_abs,
        "relation_heavy_abs_delta": rel_abs,
        "non_relation_abs_delta": nonrel_abs,
        "relation_share": (rel_abs / total_abs) if total_abs else 0.0,
        "worst_features": worst,
    }


def _live_counts(lat: float, lng: float, radius: int = 400) -> dict:
    import requests
    from pipeline.scores import osm_classify
    resp = requests.post(OVERPASS_URL, data={"data": overpass_query(lat, lng, radius)},
                         timeout=90, headers={"User-Agent": "DigiPinSpotCheck/1.0"})
    resp.raise_for_status()
    elements = resp.json().get("elements", [])
    res = osm_classify.classify_elements(elements)
    return {k: v["count"] for k, v in res.items() if v["count"] > 0}


def _pre_counts(counter, cell: dict) -> dict:
    data = counter(cell)
    out = {}
    for cat in data["categories"].values():
        for feat, fv in cat["features"].items():
            if fv["count"] > 0:
                out[feat] = fv["count"]
    return out


def _sample_cells(region: str, level: int, n: int) -> list:
    from pipeline._lib import grid, regions
    w, s, e, nn = regions._REGIONS[region]
    cells = grid.cells_for_bbox({"south": s, "north": nn, "west": w, "east": e}, level)
    if n >= len(cells):
        return cells
    step = len(cells) // n
    return [cells[i * step] for i in range(n)]


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Spot-check precomputed vs live OSM counts.")
    p.add_argument("--pbf", required=True)
    p.add_argument("--region", default="indore_pilot")
    p.add_argument("--level", type=int, default=6)
    p.add_argument("--n", type=int, default=20)
    p.add_argument("--radius", type=int, default=400)
    p.add_argument("--delay", type=float, default=2.0, help="seconds between Overpass calls")
    a = p.parse_args(argv)

    from pipeline.scores.count_features import build_bins, make_feature_counter
    print(f"Binning {a.pbf} ...", file=sys.stderr)
    counter = make_feature_counter(build_bins(a.pbf), radius_m=a.radius)
    cells = _sample_cells(a.region, a.level, a.n)
    print(f"Sampling {len(cells)} cells (Overpass, ~{a.delay}s apart) ...", file=sys.stderr)

    all_rows = []
    for i, cell in enumerate(cells):
        c = cell["center"]
        pre = _pre_counts(counter, cell)
        try:
            live = _live_counts(c["lat"], c["lng"], a.radius)
        except Exception as ex:  # noqa: BLE001
            print(f"  cell {cell['code']}: Overpass failed ({ex}) — skipped", file=sys.stderr)
            continue
        all_rows.append(compare_counts(pre, live))
        print(f"  [{i + 1}/{len(cells)}] {cell['code']}: "
              f"pre={sum(pre.values())} live={sum(live.values())}", file=sys.stderr)
        time.sleep(a.delay)

    report = summarize(all_rows)
    import json
    print(json.dumps(report, indent=2))
    rel = report["relation_share"]
    print(f"\nRelation-heavy share of total delta: {rel:.0%} "
          f"({'expected — the v1 nodes+ways gap' if rel >= 0.5 else 'low — gap is elsewhere'})",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
