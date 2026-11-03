"""Trade licences by pincode (Bengaluru; BBMP/GBA trade licence register via OpenCity, public domain).

The register lists every new and renewed trade licence from 2014 to March 2026 (9.4 lakh applications across the 27
assembly constituencies) with its date, trade category, zonal classification and the business's pincode. Each
L7 block carries its pincode's figures (dataset ``trade_licences``), joined through the ``pincodes`` dataset:

    tl_pin            pincode
    tl_fy             licences issued or renewed in 2025-26 (April 2025 to March 2026)
    tl_new_then       new licences a year, 2015-2019
    tl_new_now        new licences a year, 2022-2025
    tl_food_pct       2025-26 licences for food and drink trades (Parts 1 and 6) (%)
    tl_lodging_pct    2025-26 licences for lodging (Part 2) (%)
    tl_medical_pct    2025-26 licences for medical trades (Part 3) (%)
    tl_industry_pct   2025-26 licences in industrial zonal classes (%)

Trade names and addresses are never kept: only date, application type, trade part, zonal class and pincode are read.

    python -m pipeline.realestate.tradelicences [--region bengaluru]
"""
from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "bbmp-trade-licenses-data-2025"
FY0, FY1 = "2025-04-01", "2026-04-01"
THEN, NOW = (2015, 2019), (2022, 2025)


def pins(rows):
    """{pincode: totals} from register rows."""
    out = {}
    for r in rows:
        pin, date = (r.get("Address PIN") or "").strip(), (r.get("Date") or "")[:10]
        if len(pin) != 6 or not pin.startswith("56") or len(date) < 4:
            continue
        t = out.setdefault(int(pin), dict(fy=0, food=0, lodging=0, medical=0, industry=0, then=0, now=0))
        year = int(date[:4])
        if r.get("Application Type") == "New":
            t["then"] += THEN[0] <= year <= THEN[1]
            t["now"] += NOW[0] <= year <= NOW[1]
        if FY0 <= date < FY1:
            part = (r.get("Major Trade") or "")[:7]
            t["fy"] += 1
            t["food"] += part in ("PART-1(", "PART-6(")
            t["lodging"] += part == "PART-2("
            t["medical"] += part == "PART-3("
            t["industry"] += "INDUSTRIAL" in (r.get("Zonal Classification") or "")
    return out


def figures(t):
    pct = lambda a: round(100 * a / t["fy"], 1) if t["fy"] else None
    out = {"tl_fy": t["fy"], "tl_new_then": round(t["then"] / (THEN[1] - THEN[0] + 1), 1), "tl_new_now": round(t["now"] / (NOW[1] - NOW[0] + 1), 1),
           "tl_food_pct": pct(t["food"]), "tl_lodging_pct": pct(t["lodging"]), "tl_medical_pct": pct(t["medical"]), "tl_industry_pct": pct(t["industry"])}
    return {k: v for k, v in out.items() if v is not None}


def pin_cells(region, root=CELLS):
    """[(code, pincode)] from the pincodes dataset."""
    import json

    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "pincodes")
    t = store.read_region(root, next(r for r in ds["regions"] if r["name"] == region))
    out = []
    for c, p in zip(t.codes, t.columns["pincode"]):
        try:
            out.append((c, int(p)))
        except (TypeError, ValueError):
            continue
    return out


def records(cells, ps):
    for code, pin in cells:
        if pin in ps:
            yield {"digipin": code, "tl_pin": pin, **figures(ps[pin])}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("tl_pin", "Pincode", agg="min", ramp="viridis", higher_is=None),
        FieldSpec("tl_fy", "Trade licences issued or renewed in the pincode, 2025-26", agg="max", unit="licences", ramp="viridis", higher_is=None),
        FieldSpec("tl_new_then", "New trade licences a year in the pincode, 2015-2019", agg="max", unit="a year", ramp="viridis", higher_is=None),
        FieldSpec("tl_new_now", "New trade licences a year in the pincode, 2022-2025", agg="max", unit="a year", ramp="viridis", higher_is=None),
        FieldSpec("tl_food_pct", "Pincode licences for food and drink trades", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None),
        FieldSpec("tl_lodging_pct", "Pincode licences for lodging", agg="mean", unit="%", domain=[0, 30], ramp="viridis", higher_is=None),
        FieldSpec("tl_medical_pct", "Pincode licences for medical trades", agg="mean", unit="%", domain=[0, 30], ramp="viridis", higher_is=None),
        FieldSpec("tl_industry_pct", "Pincode licences in industrial zones", agg="mean", unit="%", domain=[0, 50], ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="trade_licences", title="Trade licences by pincode (BBMP/GBA, 2014-2026)", level=LEVEL, fields=specs, group="Real estate",
        description="BBMP/GBA's trade licence register (new and renewed licences, 2014 to March 2026) on data.opencity.in, counted "
                    "by the business's pincode: 2025-26 licences and their trade mix, and new licences a year in 2015-2019 and "
                    "2022-2025. Every block carries its pincode's figures.",
        source="pipeline/realestate/tradelicences.py (OpenCity BBMP trade licences)",
        license="Public domain (BBMP/GBA via data.opencity.in)", default_field="tl_fy", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


KEEP = ("Application Type", "Date", "Major Trade", "Zonal Classification", "Address PIN")


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    ap.add_argument("--from-dir", help="read the constituency CSVs from this folder instead of downloading")
    a = ap.parse_args(argv)
    rows = []
    if a.from_dir:
        texts = (p.read_text(encoding="utf-8-sig", errors="replace") for p in sorted(Path(a.from_dir).glob("*.csv")))
    else:
        res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PACKAGE}, timeout=60).json()["result"]["resources"]
        texts = (requests.get(r["url"], timeout=900).content.decode("utf-8-sig", errors="replace") for r in res if r["format"] == "CSV")
    for text in texts:
        rows += [{k: r.get(k) for k in KEEP} for r in csv.DictReader(io.StringIO(text))]
    ps = pins(rows)
    info = cell_dataset(a.region, list(records(pin_cells(a.region), ps)))
    print(f"{a.region}: {len(rows)} applications, {len(ps)} pincodes, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
