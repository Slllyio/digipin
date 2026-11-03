"""Property tax by ward (Chennai; Greater Chennai Corporation's ward-wise demand and collection via OpenCity, public domain).

GCC's ward-wise property tax for 2013-14 to 2017-18, residential and commercial, demand (what was billed) and collection.
Demand follows the annual rental value the corporation assesses, so residential demand per resident is a rough, official
gauge of how dear homes are. Each L7 block in a GCC ward (``wards`` dataset) carries its ward's figures
(dataset ``property_tax``):

    pt_ward              GCC ward number
    pt_res_demand_lakh   residential property tax demand, 2017-18 (₹ lakh)
    pt_com_demand_lakh   commercial property tax demand, 2017-18 (₹ lakh)
    pt_collect_pct       collected over billed, residential and commercial, 2013-14 to 2017-18 (%)
    pt_res_growth_pct    change in residential demand from 2013-14 to 2017-18 (%)

    python -m pipeline.realestate.propertytax [--region chennai]
"""
from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path

from pipeline.realestate.econcensus import ward_cells

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/3107497a-f12a-49a8-bc2a-c92c3ccb0b67/resource/27905e77-2ef3-45b6-b14a-562bd3e37944/"
       "download/7a9e3e30-9a96-4826-89da-12e3fa1902d1.csv")
YEARS = ("2013-14", "2014-15", "2015-16", "2016-17", "2017-18")


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _col(row, year, what, kind):
    return _f(row.get(f"{year} - Property Tax {what} (in crores) - {kind}"))


def wards(rows):
    """{ward number: figures} from GCC's CSV rows (Ward No. like 'N012')."""
    out = {}
    for row in rows:
        no = "".join(ch for ch in row.get("Ward No.", "") if ch.isdigit())
        if not no:
            continue
        dem = sum(_col(row, y, "Demand", k) for y in YEARS for k in ("Residential", "Commercial"))
        col = sum(_col(row, y, "Collection", k) for y in YEARS for k in ("Residential", "Commercial"))
        r0, r1 = _col(row, YEARS[0], "Demand", "Residential"), _col(row, YEARS[-1], "Demand", "Residential")
        out[int(no)] = {
            "pt_res_demand_lakh": round(100 * r1, 2), "pt_com_demand_lakh": round(100 * _col(row, YEARS[-1], "Demand", "Commercial"), 2),
            **({"pt_collect_pct": round(100 * col / dem, 1)} if dem else {}),
            **({"pt_res_growth_pct": round(100 * (r1 / r0 - 1), 1)} if r0 else {}),
        }
    return out


def records(cells, ws):
    for code, w in cells:
        if w in ws:
            yield {"digipin": code, "pt_ward": w, **ws[w]}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("pt_ward", "GCC ward", agg="min", ramp="viridis", higher_is=None),
        FieldSpec("pt_res_demand_lakh", "Ward residential property tax demand, 2017-18", agg="max", unit="₹ lakh", ramp="viridis", higher_is=None),
        FieldSpec("pt_com_demand_lakh", "Ward commercial property tax demand, 2017-18", agg="max", unit="₹ lakh", ramp="viridis", higher_is=None),
        FieldSpec("pt_collect_pct", "Ward property tax collected over billed, 2013-18", agg="mean", unit="%", domain=[50, 120], ramp="viridis", higher_is="better"),
        FieldSpec("pt_res_growth_pct", "Change in ward residential demand, 2013-14 to 2017-18", agg="mean", unit="%", domain=[-30, 60], ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="property_tax", title="Property tax by ward (GCC, 2013-18)", level=LEVEL, fields=specs, group="Real estate",
        description="Greater Chennai Corporation's ward-wise property tax demand and collection, residential and commercial, "
                    "2013-14 to 2017-18, via data.opencity.in; every block in a ward carries the ward's figures.",
        source="pipeline/realestate/propertytax.py (OpenCity Chennai property tax collections)",
        license="Public domain (Greater Chennai Corporation via data.opencity.in)", default_field="pt_res_demand_lakh", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="chennai")
    region = ap.parse_args(argv).region
    ws = wards(csv.DictReader(io.StringIO(requests.get(URL, timeout=300).content.decode("utf-8-sig"))))
    info = cell_dataset(region, list(records(ward_cells(region), ws)))
    print(f"{region}: {len(ws)} wards, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
