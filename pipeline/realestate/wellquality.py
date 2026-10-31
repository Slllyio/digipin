"""Groundwater quality at the nearest observation well, Bengaluru (Karnataka Ground Water Directorate via OpenCity, public domain).

The Directorate samples observation wells every year and publishes nitrate, fluoride, iron and total hardness for each
well with its coordinates; OpenCity carries the Bengaluru Urban tables for 2017-18 and 2018-19 (34 wells each). Per
lived-in L7 block in Bengaluru (dataset ``well_quality``), from the nearest 2018-19 well:

    wq_no3          nitrate (mg/L; BIS IS 10500 limit 45)
    wq_no3_prev     nitrate at the nearest 2017-18 well, when it is the same site (within 500 m)
    wq_f            fluoride (mg/L; acceptable 1.0, permissible 1.5)
    wq_fe           iron (mg/L; acceptable 0.3)
    wq_th           total hardness as CaCO3 (mg/L; acceptable 200, permissible 600)
    wq_km           distance to that well
    wq_wells_5km    2018-19 wells within 5 km;  wq_over_5km  of them, over the nitrate limit

Only coordinates and the four readings are read; village names are not kept.

    python -m pipeline.realestate.wellquality
"""
from __future__ import annotations

import argparse
import csv
import io
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
B = "https://data.opencity.in/dataset/49c421ab-ba20-495f-89a5-d94ba94e0ddb/resource/"
YEARS = {2018: B + "c1464e14-158d-40b2-9694-9b17bf1b6eaa/download/79471735-8a70-4d36-b21b-08ad40723960.csv",
         2017: B + "04f76594-e1ea-4d1d-8ca6-03f92ea577f0/download/e83f1d6c-f2ad-4345-9117-663d9e3e702e.csv"}
NO3_LIMIT = 45
NEAR_KM = 5.0
SAME_KM = 0.5


def _f(x):
    try:
        return float(str(x).strip())
    except ValueError:
        return None


def wells(rows):
    """[{lat, lng, no3, f, fe, th}] from a Directorate table (column names differ a little between years)."""
    def col(r, *keys):
        return next((_f(v) for k, v in r.items() if k and any(x in k.lower() for x in keys)), None)
    out = []
    for r in rows:
        la, lo = col(r, "latitude"), col(r, "longitude")
        if la is None or lo is None:
            continue
        w = {"lat": la, "lng": lo, "no3": col(r, "no3"), "f": col(r, "flouride", "fluoride"), "fe": col(r, "fe mg"), "th": col(r, "th (")}
        out.append({k: v for k, v in w.items() if v is not None})
    return out


def block_rows(cells, now, prev):
    kx = 111.32 * math.cos(math.radians(13.0))
    d = lambda la, lo, w: math.hypot((la - w["lat"]) * 110.57, (lo - w["lng"]) * kx)
    rows = {}
    for code, la, lo in cells:
        k = min(range(len(now)), key=lambda j: d(la, lo, now[j]))
        w = now[k]
        r = {f"wq_{p}": w[p] for p in ("no3", "f", "fe", "th") if p in w}
        r["wq_km"] = round(d(la, lo, w), 2)
        near = [x for x in now if d(la, lo, x) <= NEAR_KM]
        r.update(wq_wells_5km=len(near), wq_over_5km=sum(1 for x in near if x.get("no3", 0) > NO3_LIMIT))
        if prev:
            p = min(prev, key=lambda x: d(w["lat"], w["lng"], x))
            if d(w["lat"], w["lng"], p) <= SAME_KM and "no3" in p:
                r["wq_no3_prev"] = p["no3"]
        rows[code] = r
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("wq_no3", "Nitrate in groundwater at the nearest observation well, 2018-19", agg="mean", unit="mg/L", domain=[0, 120], ramp="reds", higher_is="worse"),
        FieldSpec("wq_no3_prev", "Nitrate at the same well, 2017-18", agg="mean", unit="mg/L", domain=[0, 120], ramp="reds", higher_is="worse"),
        FieldSpec("wq_f", "Fluoride in groundwater at the nearest well, 2018-19", agg="mean", unit="mg/L", domain=[0, 1.5], ramp="reds", higher_is="worse"),
        FieldSpec("wq_fe", "Iron in groundwater at the nearest well, 2018-19", agg="mean", unit="mg/L", domain=[0, 1], ramp="reds", higher_is="worse"),
        FieldSpec("wq_th", "Total hardness of groundwater at the nearest well, 2018-19", agg="mean", unit="mg/L CaCO3", domain=[100, 800], ramp="reds", higher_is="worse"),
        FieldSpec("wq_km", "Distance to the nearest observation well", agg="mean", unit="km", domain=[0, 10], ramp="viridis", higher_is=None),
        FieldSpec("wq_wells_5km", "Observation wells within 5 km", agg="mean", unit="wells", ramp="viridis", higher_is=None),
        FieldSpec("wq_over_5km", "Wells within 5 km over the nitrate limit (45 mg/L)", agg="mean", unit="wells", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="well_quality", title="Groundwater quality at observation wells (Karnataka Ground Water Directorate)", level=LEVEL,
        fields=specs, group="Environment",
        description="Nitrate, fluoride, iron and hardness in groundwater at the nearest of the Ground Water Directorate's 34 "
                    "observation wells in Bengaluru Urban (2018-19, with 2017-18 nitrate for the same well), via data.opencity.in.",
        source="pipeline/realestate/wellquality.py (Karnataka Ground Water Directorate, Bengaluru Urban taluk-wise quality via OpenCity)",
        license="Public domain (Government of Karnataka via data.opencity.in)", default_field="wq_no3", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    region = ap.parse_args(argv).region
    w = {y: wells(csv.DictReader(io.StringIO(requests.get(u, timeout=120).content.decode("utf-8-sig")))) for y, u in YEARS.items()}
    rows = block_rows(lived_cells(region), w[2018], w[2017])
    cell_dataset(region, rows)
    over = sum(1 for x in w[2018] if x.get("no3", 0) > NO3_LIMIT)
    print(f"{region}: {len(w[2018])} wells 2018-19 ({over} over the nitrate limit), {len(rows)} blocks, "
          f"{sum(1 for r in rows.values() if 'wq_no3_prev' in r)} with a 2017-18 reading at the same well")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
