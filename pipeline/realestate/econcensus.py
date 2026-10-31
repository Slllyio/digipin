"""Workplaces counted: the 6th Economic Census (2012-13) by ward (Kolkata; MoSPI microdata via OpenCity, public domain).

The census listed every establishment in Kolkata (5.4 lakh, 14.2 lakh workers) with its ward, broad activity, whether it
runs from a home, and its workers by sex. Crop farming, public administration and defence are outside its scope, so
government offices are missing. Each L7 block in a KMC ward (``wards`` dataset) carries its ward's figures
(dataset ``econ_census``):

    ec_ward          KMC ward number
    ec_workers       workers in the ward's establishments
    ec_estabs        establishments in the ward
    mfg_pct          share of workers in manufacturing (%)
    trade_pct        share in wholesale, retail and motor trade (%)
    home_pct         share of establishments run from inside a household (%)
    women_pct        share of workers who are women (%)
    women_owner_pct  share of proprietary establishments owned by a woman (%)
    hired_pct        share of workers who are hired, not owners or family (%)

Only ward, activity, household flag, ownership type, owner's sex and worker counts are read; social group and religion
columns are never parsed.

    python -m pipeline.realestate.econcensus [--region kolkata]
"""
from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/3809c2b9-cd82-45fb-a043-a6a6ed36ffd6/resource/fb6f9448-156f-48a4-bf10-b4f469f40a87/"
       "download/36e6f74c-176e-452c-92a8-9195ac9d309e.csv")
TOWN = "7110"          # Kolkata Municipal Corporation's census town code
MAX_WARD = 144
TRADE = {"10", "11", "12"}
KEEP = ("WC", "T_V", "BACT", "IN_HH", "OWN_SHIP_C", "SEX", "M_H", "F_H", "M_NH", "F_NH", "TOTAL_WORKER")


def _n(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return 0


def wards(rows):
    """{ward: totals} from census rows (dicts with at least KEEP), Kolkata town only, ward 1..MAX_WARD."""
    out = {}
    for row in rows:
        w = _n(row["WC"])
        if row["T_V"] != TOWN or not 1 <= w <= MAX_WARD:
            continue
        t = out.setdefault(w, dict(estabs=0, workers=0, mfg=0, trade=0, home=0, women=0, prop=0, prop_women=0, hired=0))
        wk = _n(row["TOTAL_WORKER"])
        t["estabs"] += 1
        t["workers"] += wk
        t["mfg"] += wk if row["BACT"] == "6" else 0
        t["trade"] += wk if row["BACT"] in TRADE else 0
        t["home"] += row["IN_HH"] == "1"
        t["women"] += _n(row["F_H"]) + _n(row["F_NH"])
        t["hired"] += _n(row["M_H"]) + _n(row["F_H"])
        if row["OWN_SHIP_C"] == "2":
            t["prop"] += 1
            t["prop_women"] += row["SEX"] == "2"
    return out


def figures(t):
    pct = lambda a, b: round(100 * a / b, 1) if b else None
    return {"ec_workers": t["workers"], "ec_estabs": t["estabs"], "mfg_pct": pct(t["mfg"], t["workers"]),
            "trade_pct": pct(t["trade"], t["workers"]), "home_pct": pct(t["home"], t["estabs"]),
            "women_pct": pct(t["women"], t["workers"]), "women_owner_pct": pct(t["prop_women"], t["prop"]),
            "hired_pct": pct(t["hired"], t["workers"])}


def ward_cells(region, root=CELLS):
    """[(code, ward number)] for blocks in the wards dataset."""
    import json

    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "wards")
    t = store.read_region(root, next(r for r in ds["regions"] if r["name"] == region))
    return [(c, _n(w)) for c, w in zip(t.codes, t.columns["ward_no"]) if _n(w)]


def records(cells, ws):
    for code, w in cells:
        if w in ws:
            yield {"digipin": code, "ec_ward": w, **{k: v for k, v in figures(ws[w]).items() if v is not None}}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("ec_ward", "KMC ward", agg="min", ramp="viridis", higher_is=None),
        FieldSpec("ec_workers", "Workers in the ward's establishments (2012-13)", agg="max", unit="workers", ramp="viridis", higher_is=None),
        FieldSpec("ec_estabs", "Establishments in the ward (2012-13)", agg="max", unit="establishments", ramp="viridis", higher_is=None),
        FieldSpec("mfg_pct", "Ward workers in manufacturing", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None),
        FieldSpec("trade_pct", "Ward workers in trade", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None),
        FieldSpec("home_pct", "Ward establishments run from a home", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None),
        FieldSpec("women_pct", "Ward workers who are women", agg="mean", unit="%", domain=[0, 50], ramp="viridis", higher_is="better"),
        FieldSpec("women_owner_pct", "Ward proprietary establishments owned by women", agg="mean", unit="%", domain=[0, 50], ramp="viridis", higher_is="better"),
        FieldSpec("hired_pct", "Ward workers who are hired", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="econ_census", title="Workplaces counted (6th Economic Census, 2012-13)", level=LEVEL, fields=specs, group="Real estate",
        description="Establishments and workers per Kolkata Municipal Corporation ward from the 6th Economic Census microdata "
                    "(MoSPI, 2012-13) on data.opencity.in, with activity, home-based and women's shares; every block in a ward "
                    "carries the ward's figures. Crop farming, public administration and defence are outside the census.",
        source="pipeline/realestate/econcensus.py (OpenCity Kolkata 6th Economic Census)",
        license="Public domain (MoSPI microdata via data.opencity.in)", default_field="ec_workers", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="kolkata")
    region = ap.parse_args(argv).region
    text = requests.get(URL, timeout=900).content.decode("utf-8-sig")
    rows = ({k: r.get(k) for k in KEEP} for r in csv.DictReader(io.StringIO(text)))
    ws = wards(rows)
    print(f"{region}: {len(ws)} wards, {sum(t['estabs'] for t in ws.values())} establishments, {sum(t['workers'] for t in ws.values())} workers")
    info = cell_dataset(region, list(records(ward_cells(region), ws)))
    print(f"{region}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
