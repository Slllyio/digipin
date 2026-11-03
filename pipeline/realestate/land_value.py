"""Relative land-value index per block: hedonic premiums from access, amenities, neighbourhood and risk.

India has no open locality-level price data (circle rates sit on state
portals, listings belong to the portals), so this is a *relative* index: each
L7 cell's value against the city median (= 100), built from premiums the
hedonic literature measures for Indian and comparable cities, applied to the
cell-store layers:

    jobs        0.35 × ln(job reach / city median), job reach = 0.6 × car +
                0.4 × train-and-walk share of jobs within 45 min (job_access);
                clipped to ±0.6 (rent-gradient / accessibility elasticities)
    metro       +10% within a 6-minute walk of a metro station, tapering to 0
                at 20 minutes (Delhi and Bengaluru metro studies: 7–15%)
    amenity     0.08 × ln((1 + POIs within ~1 km) / (1 + city median))
    neighbour   0.20 × (relative wealth index − city median) (Meta RWI, coarse
                inside a metro) + 0.30 × ln(average building footprint / city
                median), clipped ±0.4: planned plotted colonies have fewer,
                larger buildings than informal or unauthorised ones (Open
                Buildings 2023 cover ÷ count), the strongest open status signal
    green       +0.4% per point of tree canopy within ~500 m above the city
                median, capped at ±6%
    flood       −9% in the 1-in-100-year river floodplain (≥ 30% of the cell),
                −5% at very high waterlogging (index 65+), −2% at high (45+)
    noise       −0.6% per dB of road noise above 60 dB Lden, capped at −8%

value_index = 100 × exp(Σ premiums), on built-up cells (≥ 10% built or 200+
residents). Dataset ``land_value`` (L7) keeps the index, its quintile within
the city and each premium in %, so the map can show *why* a block is dear or
cheap. summary.json-style output goes to data/realestate/<region>.json with
the NHB RESIDEX anchor from data/realestate/anchors.json.

    python -m pipeline.realestate.land_value --region delhi
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
OUT = REPO / "data" / "realestate"
LEVEL = 7
B_JOBS, JOBS_CLIP = 0.35, 0.6
METRO_MAX, METRO_FULL_MIN, METRO_ZERO_MIN = 0.10, 6.0, 20.0
B_AMENITY, AMENITY_R = 0.08, 4          # ~1 km at L7 (245 m cells)
B_NEIGH = 0.20
B_GRAIN, GRAIN_CLIP = 0.30, 0.4      # plot grain: larger average footprints = planned, higher-status layouts
B_GREEN, GREEN_CAP, GREEN_R = 0.004, 0.06, 2
FLOOD_DISC, FLOOD_SHARE = -0.09, 30.0
WLOG_VHIGH, WLOG_HIGH = (65, -0.05), (45, -0.02)
NOISE_FROM, NOISE_PER_DB, NOISE_CAP = 60.0, -0.006, -0.08
MIN_BUILT, MIN_POP = 10.0, 200.0


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def metro_premium(walk_min):
    """Log premium for walking minutes to the nearest metro station."""
    if walk_min is None or walk_min >= METRO_ZERO_MIN:
        return 0.0
    if walk_min <= METRO_FULL_MIN:
        return METRO_MAX
    return METRO_MAX * (METRO_ZERO_MIN - walk_min) / (METRO_ZERO_MIN - METRO_FULL_MIN)


def jobs_premium(reach, median):
    if not reach or not median or reach <= 0 or median <= 0:
        return 0.0
    return max(-JOBS_CLIP, min(JOBS_CLIP, B_JOBS * math.log(reach / median)))


def risk_discount(flood_pct, wlog_index):
    d = 0.0
    if flood_pct is not None and flood_pct >= FLOOD_SHARE:
        d += FLOOD_DISC
    if wlog_index is not None:
        if wlog_index >= WLOG_VHIGH[0]:
            d += WLOG_VHIGH[1]
        elif wlog_index >= WLOG_HIGH[0]:
            d += WLOG_HIGH[1]
    return d


def noise_discount(lden):
    if lden is None or lden <= NOISE_FROM:
        return 0.0
    return max(NOISE_CAP, NOISE_PER_DB * (lden - NOISE_FROM))


def disk_sum(values: dict, code: str, r: int):
    """Sum of ``values`` over cells within ``r`` rows/cols (a rounded square) of ``code``."""
    ix = digipin.to_index(code)
    tot = 0.0
    for dr in range(-r, r + 1):
        for dc in range(-r, r + 1):
            if dr * dr + dc * dc > r * r + r:
                continue
            c = digipin.from_index(ix["level"], ix["row"] + dr, ix["col"] + dc)
            if c:
                tot += values.get(c, 0.0) or 0.0
    return tot


def disk_mean(values: dict, code: str, r: int):
    ix = digipin.to_index(code)
    tot = n = 0
    for dr in range(-r, r + 1):
        for dc in range(-r, r + 1):
            if dr * dr + dc * dc > r * r + r:
                continue
            c = digipin.from_index(ix["level"], ix["row"] + dr, ix["col"] + dc)
            v = values.get(c) if c else None
            if v is not None:
                tot += v
                n += 1
    return tot / n if n else None


def quintile(sorted_vals, v):
    """1–5 quintile of ``v`` within ``sorted_vals`` (ascending)."""
    import bisect
    if not sorted_vals:
        return None
    p = bisect.bisect_right(sorted_vals, v) / len(sorted_vals)
    return min(5, 1 + int(p * 5))


# ── run ─────────────────────────────────────────────────────────────────────

def _col(ds, field, region, level=LEVEL):
    """{L7 code: value}; coarser datasets are looked up by prefix in compute()."""
    t = dm._read(ds, region)
    if t is None or field not in t.columns:
        return {}, None
    return {c: v for c, v in zip(t.codes, t.columns[field]) if v is not None}, len(t.codes[0]) if t.codes else None


def _at(col, lv, code):
    if not col:
        return None
    return col.get(code[:lv]) if lv and lv < len(code) else col.get(code)


def compute(region, log=print):
    pop, _ = _col("population", "population", region)
    built, _ = _col("land_cover", "built_pct", region)
    car, lv_c = _col("job_access", "jobs_car_pct", region)
    trn, lv_t = _col("job_access", "jobs_transit_pct", region)
    metro, _ = _col("rail_access", "metro_walk_min", region)
    poi, _ = _col("osm_amenities", "poi_total", region)
    rwi, lv_w = _col("wealth", "rwi", region)
    canopy, _ = _col("vegetation", "tree_canopy_pct", region)
    flood, _ = _col("water", "flood_rp100_pct", region)
    wlog, _ = _col("waterlogging", "waterlogging_index", region)
    noise, _ = _col("traffic_noise", "lden_db", region)
    cover, _ = _col("building_stock", "cover_2023_pct", region)
    nbld, _ = _col("building_stock", "buildings_2023", region)
    cells = [c for c in set(pop) | set(built)
             if (built.get(c) or 0) >= MIN_BUILT or (pop.get(c) or 0) >= MIN_POP]
    if not cells:
        return {}, {}

    def reach(c):
        a, b = _at(car, lv_c, c), _at(trn, lv_t, c)
        if a is None and b is None:
            return None
        return 0.6 * (a or 0) + 0.4 * (b or 0)

    reaches = {c: reach(c) for c in cells}
    med = lambda xs: statistics.median(xs) if xs else None
    r_med = med([v for v in reaches.values() if v])
    amen = {c: disk_sum(poi, c, AMENITY_R) for c in cells}
    a_med = med(list(amen.values())) or 0
    w_vals = {c: _at(rwi, lv_w, c) for c in cells}
    w_med = med([v for v in w_vals.values() if v is not None])
    grain = {}
    for c in cells:
        n, cv = nbld.get(c), cover.get(c)
        if n and n >= 5 and cv:
            grain[c] = cv / n
    gr_med = med(list(grain.values()))
    green = {c: disk_mean(canopy, c, GREEN_R) for c in cells} if canopy else {}
    g_med = med([v for v in green.values() if v is not None]) if green else None
    rows = {}
    for c in cells:
        p = {
            "jobs": jobs_premium(reaches[c], r_med),
            "metro": metro_premium(metro.get(c)) if metro else 0.0,
            "amenity": B_AMENITY * math.log((1 + amen[c]) / (1 + a_med)),
            "neigh": (B_NEIGH * (w_vals[c] - w_med) if w_vals[c] is not None and w_med is not None else 0.0)
            + (max(-GRAIN_CLIP, min(GRAIN_CLIP, B_GRAIN * math.log(grain[c] / gr_med))) if c in grain and gr_med else 0.0),
            "green": max(-GREEN_CAP, min(GREEN_CAP, B_GREEN * (green[c] - g_med)))
            if green.get(c) is not None and g_med is not None else 0.0,
            "risk": risk_discount(flood.get(c), wlog.get(c)),
            "noise": noise_discount(noise.get(c)),
        }
        rows[c] = {"value_index": round(100 * math.exp(sum(p.values())), 1),
                   **{f"prem_{k}_pct": round(100 * (math.exp(v) - 1), 1) for k, v in p.items()}}
    vals = sorted(r["value_index"] for r in rows.values())
    for r in rows.values():
        r["value_quintile"] = quintile(vals, r["value_index"])
    # Re-centre on the population-weighted median so 100 = the typical resident's block.
    wv = sorted((r["value_index"], pop.get(c) or 0) for c, r in rows.items())
    tot = sum(w for _, w in wv) or 1
    acc, centre = 0.0, 100.0
    for v, w in wv:
        acc += w
        if acc >= tot / 2:
            centre = v
            break
    for r in rows.values():
        r["value_index"] = round(100 * r["value_index"] / centre, 1)
    vals = sorted(r["value_index"] for r in rows.values())
    q = lambda f: vals[min(len(vals) - 1, int(f * len(vals)))]
    share = {k: round(statistics.mean(abs(r[f"prem_{k}_pct"]) for r in rows.values()), 1)
             for k in ("jobs", "metro", "amenity", "neigh", "green", "risk", "noise")}
    summ = {"cells": len(rows), "p10": q(0.1), "p50": q(0.5), "p90": q(0.9), "p99": q(0.99),
            "spread_p90_p10": round(q(0.9) / q(0.1), 2) if q(0.1) else None,
            "mean_abs_premium_pct": share,
            "inputs_missing": [k for k, v in {"job_access": car, "rail_access": metro, "osm_amenities": poi,
                                              "wealth": rwi, "building_stock": nbld, "vegetation": canopy, "water": flood,
                                              "waterlogging": wlog, "traffic_noise": noise}.items() if not v]}
    log(f"{region}: {json.dumps(summ)}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pf = lambda k, label: FieldSpec(f"prem_{k}_pct", label, agg="mean", unit="%", domain=[-20, 20],
                                    ramp="viridis", higher_is="better")
    specs = [
        FieldSpec("value_index", "Relative land value (city median block = 100)", agg="mean", unit="index",
                  domain=[40, 250], ramp="viridis", higher_is="better"),
        FieldSpec("value_quintile", "Land-value quintile within the city", agg="mean", unit="1–5",
                  domain=[1, 5], ramp="viridis", higher_is="better"),
        pf("jobs", "Premium: jobs within 45 min"),
        pf("metro", "Premium: metro station nearby"),
        pf("amenity", "Premium: shops and services within 1 km"),
        pf("neigh", "Premium: neighbourhood status (wealth, plot size)"),
        pf("green", "Premium: tree canopy within 500 m"),
        pf("risk", "Discount: floodplain and waterlogging"),
        pf("noise", "Discount: road noise"),
    ]
    spec = DatasetSpec(
        id="land_value", title="Relative land value", level=LEVEL, fields=specs, group="Real estate",
        description="A relative land-value index per block (city's typical block = 100) built from hedonic "
                    "premiums: jobs within 45 minutes, metro proximity, shops and services within 1 km, "
                    "neighbourhood status (Meta RWI and plot size from Open Buildings), tree canopy, and discounts for floodplain, waterlogging and "
                    "road noise. Coefficients come from the hedonic literature, not fitted to Indian prices: it "
                    "ranks blocks, it does not quote rupees. Add circle rates to calibrate.",
        source="pipeline/realestate/land_value.py over job_access, rail_access, osm_amenities, wealth, building_stock, vegetation, "
               "water, waterlogging, traffic_noise",
        license="ODbL (OpenStreetMap) + CC BY 4.0 (GHSL, Meta RWI) + CDLA-Permissive-2.0 (Overture)",
        default_field="value_index", extrude=True)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def _summary(region, key, summ):
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / f"{region}.json"
    s = json.loads(p.read_text()) if p.exists() else {"region": region}
    anchors = json.loads((OUT / "anchors.json").read_text()) if (OUT / "anchors.json").exists() else {}
    a = (anchors.get("cities") or {}).get(region)
    s["anchor"] = {"hpi_yoy_pct": a["hpi_yoy_pct"] if a else anchors.get("national_50_city_yoy_pct"),
                   "scope": "city" if a else "50-city composite", "source": anchors.get("source"),
                   "period": anchors.get("period")} if anchors else None
    s[key] = summ
    p.write_text(json.dumps(s, indent=2) + "\n")


def run(region, log=print):
    rows, summ = compute(region, log)
    if not rows:
        log(f"{region}: no built-up cells, skipped")
        return None
    res = cell_dataset(region, rows)
    _summary(region, "land_value", summ)
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
