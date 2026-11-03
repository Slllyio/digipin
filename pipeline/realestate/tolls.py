"""Toll plazas around the city: the nearest plaza and what a car pays there (NHAI via OpenCity, public domain).

OpenCity's all-India toll plaza map (2024, from NHAI's fee portal) lists 1,563 plazas with their location and fees for
a car, jeep or van: single journey, return within 24 hours, monthly pass, and the concession for cars registered in
the district. NHAI plazas with no car fee listed (not collecting) are left out;
state plazas are kept without fees, which the list does not give for them. Per lived-in L7 block (dataset ``tolls``):

    toll_km           straight-line distance to the nearest toll plaza
    toll_car          car single-journey fee there (₹)
    toll_car_month    car monthly pass there (₹)
    toll_car_local    fee for cars registered in the plaza's district, where it has one (₹ a month)
    tolls_25km        toll plazas within 25 km
    toll_code         NHAI plaza code of the nearest plaza

Fees are the 2024 notified rates; NHAI revises them each April. Plaza names and concessionaires are not stored.

    python -m pipeline.realestate.tolls --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/000bb43f-6c2d-43d9-87cd-17ca7e0647f4/resource/af2ce3aa-1042-4aea-a115-709fedd4fad3/"
       "download/51bfe407-c1fe-4282-a86a-e0f8667cc106.kml")
NEAR_KM = 25


def _f(x):
    try:
        v = float(str(x).replace(",", "").strip())
        return v if v > 0 else None
    except ValueError:
        return None


def plazas(text):
    """[(lat, lng, {code, car, car_month, car_local})] for toll plazas with coordinates."""
    import xml.etree.ElementTree as ET
    tag = lambda e: e.tag.rsplit("}", 1)[-1]
    out = []
    for pm in (e for e in ET.fromstring(text).iter() if tag(e) == "Placemark"):
        d = {x.get("name"): (x.text or "").strip() for x in pm.iter() if tag(x) == "SimpleData"}
        lat, lng = _f(d.get("lat")), _f(d.get("long"))
        if lat is None or lng is None or (d.get("plaza_type") or "Toll").strip().lower() != "toll":
            continue
        if _f(d.get("carjeepvan_sj")) is None and (d.get("plaza_sub_type") or "").strip() == "National":
            continue    # an NHAI plaza with no notified car fee is not collecting (e.g. the Delhi section of the Delhi-Meerut Expressway)
        out.append((lat, lng, {"code": d.get("plaza_code"), "car": _f(d.get("carjeepvan_sj")),
                               "car_month": _f(d.get("carjeepvan_mp")), "car_local": _f(d.get("carjeepvan_reg"))}))
    return out


def block_rows(cells, pts, near_km=NEAR_KM):
    """{code: fields} for each (code, lat, lng) block from the nearest plaza and the count within ``near_km``."""
    import numpy as np
    if not cells or not pts:
        return {}
    lat0 = sum(c[1] for c in cells) / len(cells)
    kx = 111.32 * math.cos(math.radians(lat0))
    P = np.array([(p[0] * 110.57, p[1] * kx) for p in pts])
    rows = {}
    for code, lat, lng in cells:
        d = np.hypot(P[:, 0] - lat * 110.57, P[:, 1] - lng * kx)
        k = int(d.argmin())
        info = pts[k][2]
        r = {"toll_km": round(float(d[k]), 1), "tolls_25km": int((d <= near_km).sum()), "toll_code": _f(info["code"])}
        for f in ("car", "car_month", "car_local"):
            if info[f] is not None:
                r[f"toll_{f}"] = info[f]
        rows[code] = r
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("toll_km", "Distance to the nearest toll plaza", agg="mean", unit="km", domain=[0, 40], ramp="viridis", higher_is=None),
        FieldSpec("toll_car", "Car single-journey toll at the nearest plaza (2024)", agg="mean", unit="₹", domain=[0, 300], ramp="reds", higher_is="worse"),
        FieldSpec("toll_car_month", "Car monthly pass at the nearest plaza (2024)", agg="mean", unit="₹", ramp="reds", higher_is="worse"),
        FieldSpec("toll_car_local", "Monthly fee for district-registered cars at the nearest plaza", agg="mean", unit="₹", ramp="reds", higher_is="worse"),
        FieldSpec("tolls_25km", "Toll plazas within 25 km", agg="mean", unit="plazas", domain=[0, 10], ramp="viridis", higher_is=None),
        FieldSpec("toll_code", "NHAI code of the nearest toll plaza", agg="mode", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="tolls", title="Toll plazas (NHAI 2024)", level=LEVEL, fields=specs, group="Mobility",
        description="Distance from each lived-in block to the nearest national or state highway toll plaza, the car fees there "
                    "(single journey, monthly pass, district-registered concession) and the number of plazas within 25 km, from "
                    "the all-India toll plaza map (NHAI fee portal, 2024) via data.opencity.in. Straight-line distance.",
        source="pipeline/realestate/tolls.py (OpenCity all-India toll plaza locations 2024)",
        license="Public domain (NHAI via data.opencity.in)", default_field="toll_km", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    pts = plazas(requests.get(URL, timeout=300).content.decode("utf-8-sig"))
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    regions = [r["name"] for r in pop["regions"]] if a.region == "all" else a.region.split(",")
    for region in regions:
        cells = lived_cells(region)
        la = [c[1] for c in cells]
        lo = [c[2] for c in cells]
        near = [p for p in pts if min(la) - 1 <= p[0] <= max(la) + 1 and min(lo) - 1 <= p[1] <= max(lo) + 1]
        rows = block_rows(cells, near)
        if not rows:
            print(f"{region}: no toll plazas within a degree")
            continue
        cell_dataset(region, rows)
        km = sorted(r["toll_km"] for r in rows.values())
        print(f"{region}: {len(near)} plazas nearby, {len(rows)} blocks, median nearest {km[len(km) // 2]} km")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
