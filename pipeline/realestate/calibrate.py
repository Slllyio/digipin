"""Check the land value index against Delhi's official colony categories and map it to circle rates.

Delhi sorts residential colonies into categories A–H; the category sets the
circle rate, the government's minimum land value for registering a sale
(2014 notification, ₹ per m² of residential land). data/realestate/
delhi_colonies.geojson places the colonies on the map (name match to Overture
neighbourhoods or OpenStreetMap). Each colony takes the mean value index of
its L7 block and the blocks within ~500 m.

Writes data/realestate/delhi.json ``calibration``:

    spearman      rank correlation of value index and circle rate
    by_category   colonies and median value index per category
    knots         [value index, ₹/m²] at the colony deciles (rank matching),
                  which js/urban-lenses-realestate.js interpolates in logs
    within_2x     share of colonies whose matched rate is within 2× of
                  their category's rate

Circle rates are floors set in 2014 and lag the market badly in the dearest
colonies; treat ₹ figures as an official-rate equivalent, not a price.

    python -m pipeline.realestate.calibrate
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path

from pipeline._lib import digipin
from pipeline.realestate import land_value as lv

REPO = Path(__file__).resolve().parents[2]
COLONIES = REPO / "data" / "realestate" / "delhi_colonies.geojson"
# Delhi circle rates for residential land, ₹ per m² (Revenue Department, 2014 revision).
CIRCLE_RATE = {"A": 774000, "B": 245520, "C": 159840, "D": 127680, "E": 70080, "F": 56640, "G": 46200, "H": 23280}
RATE_SOURCE = "Delhi Revenue Department circle rates for residential land, 2014 revision (categories A–H)"
NEAR_R = 2
DECILES = 11


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def ranks(xs):
    """Average ranks (0-based), ties shared."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(xs, ys):
    if len(xs) < 3:
        return None
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx)
    vy = sum((b - my) ** 2 for b in ry)
    return cov / math.sqrt(vx * vy) if vx and vy else None


def quantile(sorted_xs, q):
    if not sorted_xs:
        return None
    p = q * (len(sorted_xs) - 1)
    lo = math.floor(p)
    hi = min(lo + 1, len(sorted_xs) - 1)
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (p - lo)


def knots(vis, rates, n=DECILES):
    """Rank-matched [value index, rate] pairs at n evenly spaced quantiles (rates matched in logs)."""
    sv, lr = sorted(vis), sorted(math.log(r) for r in rates)
    out = []
    for k in range(n):
        q = k / (n - 1)
        out.append([round(quantile(sv, q), 1), round(math.exp(quantile(lr, q)))])
    return out


def interp_rate(kn, vi):
    """Log-linear interpolation of the rate at value index ``vi`` (clamped to the end knots)."""
    if vi <= kn[0][0]:
        return kn[0][1]
    for (x0, r0), (x1, r1) in itertools.pairwise(kn):
        if vi <= x1:
            t = 0 if x1 == x0 else (vi - x0) / (x1 - x0)
            return math.exp(math.log(r0) + t * (math.log(r1) - math.log(r0)))
    return kn[-1][1]


# ── run ─────────────────────────────────────────────────────────────────────

def compute(log=print):
    fc = json.loads(COLONIES.read_text())
    vi = lv._col("land_value", "value_index", "delhi")[0]
    rows = []
    for f in fc["features"]:
        cat = f["properties"].get("category")
        if cat not in CIRCLE_RATE:
            continue
        lon, lat = f["geometry"]["coordinates"]
        code = digipin.normalize(digipin.encode(lat, lon))[:lv.LEVEL]
        v = lv.disk_mean(vi, code, NEAR_R)
        if v is not None:
            rows.append((cat, v))
    vis, rates = [v for _, v in rows], [CIRCLE_RATE[c] for c, _ in rows]
    kn = knots(vis, rates)
    ok = sum(1 for v, r in zip(vis, rates) if abs(math.log(interp_rate(kn, v) / r)) < math.log(2))
    by = {}
    for c in sorted(CIRCLE_RATE):
        xs = sorted(v for k, v in rows if k == c)
        if xs:
            by[c] = {"colonies": len(xs), "median_value_index": round(quantile(xs, 0.5), 1), "circle_rate": CIRCLE_RATE[c]}
    out = {"colonies": len(rows), "spearman": round(spearman(vis, rates), 3), "by_category": by, "knots": kn,
           "within_2x": round(ok / len(rows), 3) if rows else None, "rate_source": RATE_SOURCE,
           "colony_source": fc.get("source")}
    log(json.dumps({k: v for k, v in out.items() if k not in ("by_category", "knots", "colony_source")}))
    return out


def main(argv=None):
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    lv._summary("delhi", "calibration", compute())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
