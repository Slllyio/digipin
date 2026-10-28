"""Pothole and road-cut complaints per block from BBMP's Fix My Street log, May and June 2022 (OpenCity, public domain).

Per L7 block (dataset ``potholes``):

    reports      pothole and road-cut complaints the BBMP accepted (rejected ones left out)
    road_cuts    of them, roads dug up by a utility (BESCOM, BWSSB, cable laying) and left unrepaired
    fixed        of them, marked work done or resolved by the end of June 2022
    pothole_m2   road surface to repair, m2 (the engineers' measured length x width)
    repair_rs    the engineers' repair estimate, rupees
    main_road    of the reports, ones on arterial or sub-arterial roads

Log: BBMP's Fix My Street pothole requests (about 16,500 between late April and June 2022; 3,100 rejected), with
location, status, measured size and repair estimate. Phone numbers and names in the log are not read.

    python -m pipeline.realestate.potholes
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/3a1a98f8-f924-4257-a2a1-3b957b55b9f5/resource/d1d4a437-95ee-4327-9154-f9a8933b2110/"
       "download/63b30ddf-5919-43d0-a6cf-17d5cc90a35c.kml")
PLACEMARK = re.compile(r"<Placemark\b[^>]*>(.*?)</Placemark>", re.S)
DATA = re.compile(r'<SimpleData name="(\w+)">([^<]*)<')
FIXED = ("work done", "resolved", "closed")
KEEP = ("Latitude", "Longitude", "Status", "Type_of_Wo", "Type_of_Ro", "Area__in_s", "Total_Esti")


def num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return x if x == x and x >= 0 else 0.0


def complaints(text):
    """Accepted complaints as dicts with only the fields the dataset uses (no names or phone numbers)."""
    for m in PLACEMARK.finditer(text):
        p = {k: v.strip() for k, v in DATA.findall(m.group(1)) if k in KEEP}
        if p.get("Status", "").lower() == "rejected":
            continue
        try:
            lat, lng = float(p["Latitude"]), float(p["Longitude"])
        except (KeyError, ValueError):
            continue
        if 11 < lat < 14 and 76 < lng < 79:
            yield {**p, "lat": lat, "lng": lng}


def records(items):
    for p in items:
        r = {"lat": p["lat"], "lng": p["lng"], "reports": 1, "pothole_m2": num(p.get("Area__in_s")), "repair_rs": num(p.get("Total_Esti"))}
        if p.get("Type_of_Wo", "").lower() == "road cutting":
            r["road_cuts"] = 1
        if p.get("Status", "").lower() in FIXED:
            r["fixed"] = 1
        if "arterial" in p.get("Type_of_Ro", "").lower():
            r["main_road"] = 1
        yield r


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("reports", "Pothole complaints (May-June 2022)", agg="sum", unit="reports", ramp="reds", higher_is="worse"),
        FieldSpec("road_cuts", "Road-cut complaints (utility digging)", agg="sum", unit="reports", ramp="reds", higher_is="worse"),
        FieldSpec("fixed", "Complaints fixed by end of June 2022", agg="sum", unit="reports", ramp="greens", higher_is="better"),
        FieldSpec("pothole_m2", "Road surface to repair", agg="sum", unit="m2", ramp="reds", higher_is="worse"),
        FieldSpec("repair_rs", "Repair estimate", agg="sum", unit="Rs", ramp="reds", higher_is="worse"),
        FieldSpec("main_road", "Complaints on arterial and sub-arterial roads", agg="sum", unit="reports", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="potholes", title="Pothole complaints (BBMP Fix My Street 2022)", level=LEVEL, fields=specs, group="Mobility",
        description="BBMP's Fix My Street pothole and road-cut complaints for May and June 2022 on data.opencity.in: accepted "
                    "complaints per block, how many were fixed, road surface to repair and the engineers' repair estimate.",
        source="pipeline/realestate/potholes.py (OpenCity BBMP Fix My Street data)",
        license="Public domain (BBMP via data.opencity.in)", default_field="reports", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--map", help="the downloaded KML (fetched when left out)")
    a = ap.parse_args(argv)
    text = open(a.map, encoding="utf-8-sig").read() if a.map else requests.get(URL, timeout=600).content.decode("utf-8-sig")
    items = list(complaints(text))
    info = cell_dataset("bengaluru", list(records(items)))
    fixed = sum(p.get("Status", "").lower() in FIXED for p in items)
    print(f"bengaluru: {len(items)} accepted complaints, {fixed} fixed, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
