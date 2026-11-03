"""Civic works ordered by constituency (Bengaluru; BBMP work orders 2018-2023 via OpenCity, public domain).

BBMP's work orders for 2018-19 to 2022-23, categorised and summed per assembly constituency (gross amount). Each L7
block inside both an assembly constituency (``constituencies`` dataset) and the corporation (``wards`` dataset) carries
its constituency's totals (dataset ``work_orders``), so lenses can divide them by the residents the corporation serves:

    wo_ac            assembly constituency number
    wo_total_cr      all work orders, 2018-2023 (₹ crore)
    wo_roads_cr      roads and infrastructure, roads and drains (₹ crore)
    wo_drains_cr     storm-water drainage (₹ crore)
    wo_water_cr      water and sanitation (₹ crore)
    wo_lights_cr     street lighting (₹ crore)
    wo_waste_cr      waste management (₹ crore)
    wo_buildings_cr  buildings and facilities (₹ crore)

About a third of the money (₹8,023 crore) is tagged to several wards or none and is left out.

    python -m pipeline.realestate.workorders [--region bengaluru]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "bbmp-work-orders-categorised-2018-2023"
FIELDS = {   # field: CSV columns in rupees, summed
    "wo_total_cr": ("Grand Total",), "wo_roads_cr": ("Roads and Infrastructure", "Roads and Drains"), "wo_drains_cr": ("Drainage",),
    "wo_water_cr": ("Water and Sanitation",), "wo_lights_cr": ("Street Lighting",), "wo_waste_cr": ("Waste Management",),
    "wo_buildings_cr": ("Buildings and Facilities",),
}


def _f(x):
    try:
        return float(str(x).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def constituencies(rows):
    """{AC number: {field: ₹ crore}} from the constituency-wise CSV (the Uncategorized row is skipped)."""
    out = {}
    for r in rows:
        ac = (r.get("AC Num") or "").strip()
        if ac.isdigit():
            out[int(ac)] = {k: round(sum(_f(r.get(c)) for c in cols) / 1e7, 2) for k, cols in FIELDS.items()}
    return out


def _column(root, dataset, region, field):
    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == dataset)
    t = store.read_region(root, next(r for r in ds["regions"] if r["name"] == region))
    return dict(zip(t.codes, t.columns[field]))


def ac_cells(region, root=CELLS):
    """[(code, AC number)] for blocks with a corporation ward and an assembly constituency."""
    acs, wards = _column(root, "constituencies", region, "ac_no"), _column(root, "wards", region, "ward")
    out = []
    for code, ac in acs.items():
        if wards.get(code) and ac is not None:
            try:
                out.append((code, int(ac)))
            except (TypeError, ValueError):
                continue
    return out


def records(cells, acs):
    for code, ac in cells:
        if ac in acs:
            yield {"digipin": code, "wo_ac": ac, **acs[ac]}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    labels = {"wo_total_cr": "All work orders", "wo_roads_cr": "Roads", "wo_drains_cr": "Storm-water drains", "wo_water_cr": "Water and sanitation",
              "wo_lights_cr": "Street lighting", "wo_waste_cr": "Waste management", "wo_buildings_cr": "Buildings and facilities"}
    specs = [FieldSpec("wo_ac", "Assembly constituency number", agg="min", ramp="viridis", higher_is=None)]
    specs += [FieldSpec(k, f"{v} ordered in the constituency, 2018-2023", agg="max", unit="₹ crore", ramp="viridis", higher_is=None) for k, v in labels.items()]
    spec = DatasetSpec(
        id="work_orders", title="Civic works ordered by constituency (BBMP 2018-2023)", level=LEVEL, fields=specs, group="Real estate",
        description="BBMP's work orders 2018-19 to 2022-23 (gross), categorised and summed per assembly constituency, from "
                    "data.opencity.in. Every corporation block in a constituency carries the constituency's totals; work "
                    "tagged to several wards or none (₹8,023 crore) is left out.",
        source="pipeline/realestate/workorders.py (OpenCity BBMP work orders categorised 2018-2023)",
        license="Public domain (BBMP via data.opencity.in)", default_field="wo_total_cr", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    region = ap.parse_args(argv).region
    res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PACKAGE}, timeout=60).json()["result"]["resources"]
    url = next(r["url"] for r in res if "Constituency" in r["name"] and "Gross" in r["name"])
    acs = constituencies(csv.DictReader(io.StringIO(requests.get(url, timeout=120).content.decode("utf-8-sig"))))
    info = cell_dataset(region, list(records(ac_cells(region), acs)))
    print(f"{region}: {len(acs)} constituencies, ₹{round(sum(a['wo_total_cr'] for a in acs.values()))} crore, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
