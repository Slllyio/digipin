"""Groundwater depth by ward (Chennai) and groundwater prospects (Bengaluru) per block (OpenCity, public domain).

Per L7 block (dataset ``groundwater_local``):

    gw_may_m       depth to groundwater in May 2023, before the monsoon, at the ward's CMWSSB monitoring well, m (Chennai)
    gw_dec_m       depth in December 2023, after the north-east monsoon, m (Chennai)
    gw_change_m    change in March depth from 2021 to 2024, m; positive means the water table fell (Chennai)
    gw_prospect    groundwater prospect class of the ground under the block centre: 1 poor to nil, 2 poor,
                   3 moderate to poor, 4 moderate, 5 good (Bengaluru)

Sources: CMWSSB's ward-wise monthly groundwater depth tables (one monitoring well per ward, 200 wards, 2021-2024) joined
to the ``wards`` dataset by ward number; the Bengaluru groundwater potential map (prospect zones from geology,
geomorphology and lineaments; water body and habitation masks left out).

    python -m pipeline.realestate.groundwater --region chennai,bengaluru
"""
from __future__ import annotations

import argparse
import csv
import io
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
O = "https://data.opencity.in/dataset/"
CHENNAI = {
    2021: O + "8ed6e15c-ea1f-4f41-850a-9c52090f3647/resource/61ef9b4e-feae-4e73-b503-aa2cba9eda50/download/933767dd-306d-41f3-894d-d7f4b5ee27e6.csv",
    2023: O + "8ed6e15c-ea1f-4f41-850a-9c52090f3647/resource/2ccf989b-a340-4c49-8264-80a0b60717aa/download/fb45ece0-04ef-451c-bceb-95138b098c8c.csv",
    2024: O + "8ed6e15c-ea1f-4f41-850a-9c52090f3647/resource/3a41ca9e-dbe1-495a-9ee3-c14aeaa988c6/download/a6f24910-b2cc-40e6-b08e-9dd7c37a1f4f.csv",
}
BENGALURU = O + "035c1d40-8f4e-4780-90c5-ff1ce2281849/resource/d3ae3603-d786-4782-ae71-a034ad4ebc0b/download/1dda919d-ff28-4aa9-90ce-bd18e708927b.kml"
PROSPECT = {"poor to nil": 1, "poor": 2, "moderate to poor": 3, "moderate": 4, "good": 5}
PLACEMARK = re.compile(r"<Placemark\b[^>]*>(.*?)</Placemark>", re.S)
PROS = re.compile(r'<SimpleData name="GW_PROS">([^<]*)<')


def depths(text):
    """{ward number: {month: depth m}} from one year's CMWSSB table; subtotal and average rows and zero (unread) depths dropped."""
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        try:
            ward = int(r.get("Dept No.", ""))
        except ValueError:
            continue
        months = {}
        for m in ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"):
            try:
                d = float(r[m])
            except (KeyError, ValueError):
                continue
            if d > 0:     # 0 marks a well not read that month
                months[m] = d
        if months:
            out[ward] = months
    return out


def chennai_rows(ward_of, years):
    """{code: fields} for blocks whose ward has a well; ward_of {code: ward number string}."""
    y21, y23, y24 = years.get(2021, {}), years.get(2023, {}), years.get(2024, {})
    per_ward = {}
    for w in set(y23) | set(y24):
        r = {}
        if "May" in y23.get(w, {}):
            r["gw_may_m"] = round(y23[w]["May"], 2)
        if "Dec" in y23.get(w, {}):
            r["gw_dec_m"] = round(y23[w]["Dec"], 2)
        if "Mar" in y24.get(w, {}) and "Mar" in y21.get(w, {}):
            r["gw_change_m"] = round(y24[w]["Mar"] - y21[w]["Mar"], 2)
        if r:
            per_ward[w] = r
    out = {}
    for code, w in ward_of.items():
        try:
            r = per_ward.get(int(float(w)))
        except (TypeError, ValueError):
            r = None
        if r:
            out[code] = dict(r)
    return out


def prospect_polygons(text):
    """[(class 1-5, GeoJSON MultiPolygon)] from the Bengaluru prospect map; masks dropped."""
    from pipeline.realestate.landuse2017 import INNER, OUTER, POLY, ring
    out = []
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        p = PROS.search(body)
        cls = PROSPECT.get((p.group(1) if p else "").strip().lower())
        if not cls:
            continue
        polys = []
        for pg in POLY.finditer(body):
            o = OUTER.search(pg.group(1))
            if o:
                rings = [ring(o.group(1))] + [ring(h) for h in INNER.findall(pg.group(1))]
                rings = [r + ([r[0]] if r and r[0] != r[-1] else []) for r in rings]
                if len(rings[0]) >= 4:
                    polys.append([r for r in rings if len(r) >= 4])
        if polys:
            out.append((cls, {"type": "MultiPolygon", "coordinates": polys}))
    return out


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("gw_may_m", "Depth to groundwater, May 2023 (pre-monsoon)", agg="mean", unit="m", domain=[0, 10], ramp="reds", higher_is="worse"),
        FieldSpec("gw_dec_m", "Depth to groundwater, December 2023 (post-monsoon)", agg="mean", unit="m", domain=[0, 10], ramp="reds", higher_is="worse"),
        FieldSpec("gw_change_m", "Fall in the March water table, 2021 to 2024", agg="mean", unit="m", domain=[-2, 2], ramp="diverging", higher_is="worse"),
        FieldSpec("gw_prospect", "Groundwater prospect (1 poor to nil, 5 good)", agg="mean", unit="class", domain=[1, 5], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="groundwater_local", title="Groundwater depth and prospects (city maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Depth to groundwater at each ward's CMWSSB monitoring well (Chennai, 2021-2024) and the groundwater "
                    "prospect class under each block (Bengaluru groundwater potential map), from data.opencity.in.",
        source="pipeline/realestate/groundwater.py (OpenCity CMWSSB ward groundwater tables and Bengaluru groundwater potential map)",
        license="Public domain (CMWSSB and Government of Karnataka via data.opencity.in)", default_field="gw_may_m", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import os

    import requests

    from pipeline.realestate.powerplants import lived_cells
    from pipeline.realestate.registration import assign
    from pipeline.realestate.serviceareas import read_column
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="chennai,bengaluru")
    ap.add_argument("--from-dir", help="read the files (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)

    def fetch(url):
        local = os.path.join(a.from_dir, url.rsplit("/", 1)[-1]) if a.from_dir else None
        if local and os.path.exists(local):
            return open(local, encoding="utf-8-sig").read()
        return requests.get(url, timeout=300).content.decode("utf-8-sig")

    for r in a.region.split(","):
        if r == "chennai":
            years = {y: depths(fetch(u)) for y, u in CHENNAI.items()}
            rows_ = chennai_rows(read_column(r, "wards", "ward"), years)
            note = f"{len(years[2023])} ward wells"
        else:
            polys = prospect_polygons(fetch(BENGALURU))
            got = assign(lived_cells(r), [(None, None, g) for _, g in polys])
            rows_ = {c: {"gw_prospect": polys[k][0]} for c, k in got.items()}
            note = f"{len(polys)} prospect zones"
        info = cell_dataset(r, rows_)
        print(f"{r}: {note}, {len(rows_)} blocks, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
