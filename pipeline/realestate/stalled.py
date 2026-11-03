"""Construction sites per block from the monthly Dynamic World series: started, progressing or stalled.

Compares two dry seasons (December–May) a year apart in ``construction_monthly``, so
monsoon cloud and seasonal fields matter less. Per L7 block (dataset ``sites``):

    bare_then, bare_now     mean bare-ground probability, first and second dry season
    built_then, built_now   mean built-up probability, same seasons
    site_status             0 no site, 1 cleared this year, 2 building up, 3 stalled
    stalled                 1 if the block reads as a site that has not moved for a year

The city-wide median change between the seasons is removed first, since a hazier or
wetter season shifts every block. A site is cleared ground (bare ≥ SITE_BARE) inside a built context. Stalled = cleared in
both seasons with built-up moving less than STALL_BUILT points; building up = built-up up
GROW_BUILT points or more; cleared this year = bare up CLEAR_UP points or more, or built-up
down GROW_BUILT points with bare up as much (demolition).

    python -m pipeline.realestate.stalled --region all
"""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
THEN = ("2024-12", "2025-01", "2025-02", "2025-03", "2025-04", "2025-05")
NOW = ("2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05")
SITE_BARE, CLEAR_UP, STALL_BUILT, GROW_BUILT, CONTEXT_BUILT = 25, 15, 5, 10, 15


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if len(xs) >= 2 else None


def classify(bare0, bare1, built0, built1):
    """0 none, 1 cleared this year, 2 building up, 3 stalled (see module doc)."""
    if None in (bare0, bare1, built0, built1) or max(built0, built1) < CONTEXT_BUILT:
        return 0
    if built1 - built0 >= GROW_BUILT and bare0 >= SITE_BARE:
        return 2
    if bare0 >= SITE_BARE and bare1 >= SITE_BARE and abs(built1 - built0) < STALL_BUILT:
        return 3
    if bare1 >= SITE_BARE and (bare1 - bare0 >= CLEAR_UP or (built0 - built1 >= GROW_BUILT and bare1 - bare0 >= GROW_BUILT)):
        return 1
    return 0


def rows_for(region):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    d = next(x for x in cat["datasets"] if x["id"] == "construction_monthly")
    e = next((x for x in d["regions"] if x["name"] == region), None)
    if e is None:
        return []
    t = store.read_region(CELLS, e)
    i0 = [t.times.index(m) for m in THEN if m in t.times]
    i1 = [t.times.index(m) for m in NOW if m in t.times]
    seasons = []
    for k, code in enumerate(t.codes):
        b, u = t.columns["bare_pct"][k], t.columns["built_pct"][k]
        seasons.append((code, _mean([b[i] for i in i0]), _mean([b[i] for i in i1]), _mean([u[i] for i in i0]), _mean([u[i] for i in i1])))
    # A hazier or wetter season shifts the whole city; take the median change in built-up blocks out first.
    ctx = [x for x in seasons if None not in x[1:] and max(x[3], x[4]) >= CONTEXT_BUILT]
    db = statistics.median(x[2] - x[1] for x in ctx) if ctx else 0
    du = statistics.median(x[4] - x[3] for x in ctx) if ctx else 0
    rows = []
    for code, b0, b1, u0, u1 in seasons:
        st = classify(b0, b1 - db if b1 is not None else None, u0, u1 - du if u1 is not None else None)
        if st == 0 and (b0 is None or b0 < SITE_BARE) and (b1 is None or b1 < SITE_BARE):
            continue
        rows.append({"digipin": code, "bare_then": _r(b0), "bare_now": _r(b1), "built_then": _r(u0), "built_now": _r(u1),
                     "site_status": st, "stalled": int(st == 3)})
    return rows


def _r(v):
    return round(v, 1) if v is not None else None


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("bare_then", "Bare ground, Dec 2024–May 2025", agg="mean", unit="%", domain=[0, 60], ramp="heat"),
        FieldSpec("bare_now", "Bare ground, Dec 2025–May 2026", agg="mean", unit="%", domain=[0, 60], ramp="heat"),
        FieldSpec("built_then", "Built-up, Dec 2024–May 2025", agg="mean", unit="%", domain=[0, 100], ramp="viridis"),
        FieldSpec("built_now", "Built-up, Dec 2025–May 2026", agg="mean", unit="%", domain=[0, 100], ramp="viridis"),
        FieldSpec("site_status", "Site: 1 cleared this year, 2 building up, 3 stalled", agg="max", unit="class", domain=[0, 3], ramp="heat",
                  higher_is=None),
        FieldSpec("stalled", "Stalled site (cleared a year, not built up)", agg="max", unit="yes/no", domain=[0, 1], ramp="reds",
                  higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="sites", title="Construction sites: started, building, stalled", level=LEVEL, fields=specs, group="Real estate",
        description="Two dry seasons a year apart (December–May) of the monthly Dynamic World built-up and bare-ground probabilities "
                    f"in construction_monthly. In blocks at least {CONTEXT_BUILT}% built-up, a site is bare ground of "
                    f"{SITE_BARE}% or more: stalled if it stays bare and built-up moves under {STALL_BUILT} points in a year, "
                    f"building up if built-up rises {GROW_BUILT}+ points, cleared this year if bare ground rises {CLEAR_UP}+ points "
                    f"or built-up falls {GROW_BUILT}+ while bare ground rises as much (demolition). "
                    "Quarries, dry plots and fair grounds can read as stalled sites; check on the satellite view.",
        source="pipeline/realestate/stalled.py (from construction_monthly, Dynamic World V1)",
        license="CC BY 4.0 (Dynamic World)", default_field="site_status", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = rows_for(r)
        n = {s: sum(1 for x in rows if x["site_status"] == s) for s in (1, 2, 3)}
        print(f"{r}: {n[1]} cleared, {n[2]} building up, {n[3]} stalled")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
