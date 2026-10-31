"""Recorded crime in the 19 metropolitan cities, 2022-2024 (NCRB Crime in India 2024 via OpenCity, public domain).

NCRB's metropolitan-city tables (cities of 20 lakh or more at the 2011 census, police commissionerate areas) give
cases registered for 2022-2024, the 2024 rate per lakh people and the share of cases charge-sheeted. Each city's L5
blocks carry its figures (dataset ``city_crime``, one value per city):

    cr_total_2022 / _2023 / _2024   cognizable crimes registered (IPC/BNS and special and local laws)
    cr_rate          those per lakh people, 2024 (NCRB divides by the 2011 census population)
    cr_rate_median   the 19-city median of cr_rate
    cr_ipc_rate      IPC/BNS crimes per lakh people, 2024;  cr_ipc_chargesheet_pct  charge-sheeting rate
    cr_women_2024 / cr_women_rate      crimes against women, and per lakh women
    cr_children_2024 / cr_senior_2024  crimes against children and against people 60 or older
    cr_econ_2024 / cr_fraud_2024       economic offences, of which forgery, cheating and fraud
    cr_cyber_2022 / cr_cyber_2024 / cr_cyber_rate / cr_cyber_chargesheet_pct   cyber crimes
    cr_chargesheet_pct  charge-sheeting rate, all cognizable crimes 2024

Recorded crime depends on how readily police register cases (Delhi and Kerala register most complaints, including
e-FIRs for theft), so it measures reporting as much as crime. Tables on crimes against Scheduled Castes and Tribes
are not read.

    python -m pipeline.realestate.citycrime --region all
"""
from __future__ import annotations

import argparse
import io
import statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 5
BASE = "https://data.opencity.in/dataset/7d883875-921a-4820-b298-713c6219bd90/resource/"
TABLES = {    # key: resource path
    "total": "d5b81375-7f97-4a66-bbcc-e7aadb89140e/download/table_1b.3.xlsx",
    "ipc": "c120a034-bf9c-4a7f-8259-16dc1425bf72/download/table_1b.1.xlsx",
    "women": "608413b5-5ff8-4b2b-ba8a-4c620c8837ba/download/table_3b.1.xlsx",
    "children": "da728e96-58b8-48d0-84a0-e93b5c120f16/download/table_4b.1.xlsx",
    "senior": "4da7b8d7-e4a3-497f-b88e-2562774d591b/download/vol2-6b.1.xlsx",
    "econ": "fad2c291-d486-44ac-b88f-0cd754d87e87/download/vol2-8b.2.xlsx",
    "cyber": "c3e62daf-6c30-43b4-b937-be635ff175df/download/vol2-9b.1.xlsx",
}
CITY = {"ahmedabad": "Ahmedabad", "bengaluru": "Bengaluru", "chennai": "Chennai", "delhi": "Delhi", "hyderabad": "Hyderabad",
        "indore_pilot": "Indore", "jaipur": "Jaipur", "kolkata": "Kolkata", "lucknow": "Lucknow", "mumbai": "Mumbai", "pune": "Pune"}


def table(rows):
    """{city: {header: value}} from a metropolitan-city sheet ('Bengaluru (Karnataka)' -> 'Bengaluru', 'Delhi City' -> 'Delhi')."""
    rows = [list(r) for r in rows if r and any(c is not None for c in r)]
    h = next(k for k, r in enumerate(rows) if any(str(c).strip() == "City" for c in r if c is not None))
    head = [str(c).strip() if c is not None else "" for c in rows[h]]
    out = {}
    for r in rows[h + 1:]:
        d = dict(zip(head, r))
        city = str(d.get("City") or "").split("(")[0].replace(" City", "").strip()
        if city and not city.upper().startswith("TOTAL") and not city.startswith("Source"):
            out[city] = d
    return out


def _col(d, *starts):
    """Value of the first column whose header starts with one of ``starts``."""
    for s in starts:
        for k, v in d.items():
            if k.startswith(s) and isinstance(v, (int, float)):
                return float(v)
    return None


def figures(t):
    """{city: {field: value}} from the parsed tables ``t`` (key -> table()), plus the 19-city median rate."""
    out = {}
    for city, d in t["total"].items():
        f = {"cr_total_2022": _col(d, "2022"), "cr_total_2023": _col(d, "2023"), "cr_total_2024": _col(d, "2024"),
             "cr_rate": _col(d, "Rate"), "cr_chargesheet_pct": _col(d, "Chargesheeting")}
        if (i := t["ipc"].get(city)):
            f.update(cr_ipc_rate=_col(i, "Rate"), cr_ipc_chargesheet_pct=_col(i, "Chargesheeting"))
        if (w := t["women"].get(city)):
            f.update(cr_women_2024=_col(w, "2024"), cr_women_rate=_col(w, "Rate"))
        if (c := t["children"].get(city)):
            f["cr_children_2024"] = _col(c, "2024")
        if (s := t["senior"].get(city)):
            f["cr_senior_2024"] = _col(s, "2024 (Total)", "2024")
        if (e := t["econ"].get(city)):
            f.update(cr_econ_2024=_col(e, "Total"), cr_fraud_2024=_col(e, "Forgery"))
        if (y := t["cyber"].get(city)):
            f.update(cr_cyber_2022=_col(y, "2022"), cr_cyber_2024=_col(y, "2024"), cr_cyber_rate=_col(y, "Rate"),
                     cr_cyber_chargesheet_pct=_col(y, "Chargesheeting"))
        out[city] = {k: v for k, v in f.items() if v is not None}
    med = statistics.median(x["cr_rate"] for x in out.values() if "cr_rate" in x)
    for x in out.values():
        x["cr_rate_median"] = round(med, 1)
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    n = lambda k, label, unit="cases": FieldSpec(k, label, agg="max", unit=unit, ramp="reds", higher_is="worse")
    r = lambda k, label: FieldSpec(k, label, agg="mean", unit="per lakh", ramp="reds", higher_is="worse")
    p = lambda k, label: FieldSpec(k, label, agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is="better")
    specs = [
        n("cr_total_2022", "Cognizable crimes registered in the police city, 2022"),
        n("cr_total_2023", "Cognizable crimes registered in the police city, 2023"),
        n("cr_total_2024", "Cognizable crimes registered in the police city, 2024"),
        r("cr_rate", "Cognizable crimes per lakh people, 2024"),
        r("cr_rate_median", "Cognizable crimes per lakh people, median of 19 metropolitan cities"),
        r("cr_ipc_rate", "IPC/BNS crimes per lakh people, 2024"),
        p("cr_chargesheet_pct", "Cases charge-sheeted, all cognizable crimes 2024"),
        p("cr_ipc_chargesheet_pct", "Cases charge-sheeted, IPC/BNS crimes 2024"),
        n("cr_women_2024", "Crimes against women, 2024"),
        r("cr_women_rate", "Crimes against women per lakh women, 2024"),
        n("cr_children_2024", "Crimes against children, 2024"),
        n("cr_senior_2024", "Crimes against people 60 or older, 2024"),
        n("cr_econ_2024", "Economic offences, 2024"),
        n("cr_fraud_2024", "Forgery, cheating and fraud, 2024"),
        n("cr_cyber_2022", "Cyber crimes, 2022"),
        n("cr_cyber_2024", "Cyber crimes, 2024"),
        r("cr_cyber_rate", "Cyber crimes per lakh people, 2024"),
        p("cr_cyber_chargesheet_pct", "Cyber crime cases charge-sheeted, 2024"),
    ]
    spec = DatasetSpec(
        id="city_crime", title="Recorded crime (NCRB 2024)", level=LEVEL, fields=specs, group="Safety",
        description="Cognizable crimes registered in the police city for 2022-2024, the 2024 rate per lakh people (on the 2011 "
                    "census population), charge-sheeting rates, and crimes against women, children and older people, economic "
                    "offences and cyber crime, from NCRB's Crime in India 2024 metropolitan-city tables (via data.opencity.in). "
                    "One value per city; recorded crime reflects how readily police register cases.",
        source="pipeline/realestate/citycrime.py (NCRB Crime in India 2024, metropolitan-city tables via OpenCity)",
        license="Public domain (NCRB via data.opencity.in)", default_field="cr_rate", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import openpyxl
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    t = {k: table(openpyxl.load_workbook(io.BytesIO(requests.get(BASE + u, timeout=120).content), read_only=True).active.iter_rows(values_only=True))
         for k, u in TABLES.items()}
    fig = figures(t)
    for region in (list(CITY) if a.region == "all" else a.region.split(",")):
        f = fig.get(CITY.get(region, ""))
        if not f:
            print(f"{region}: not among NCRB's 19 metropolitan cities")
            continue
        info = cell_dataset(region, f)
        print(f"{region}: {f['cr_total_2024']:.0f} crimes 2024, {f['cr_rate']} per lakh, cyber {f.get('cr_cyber_2024')}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
