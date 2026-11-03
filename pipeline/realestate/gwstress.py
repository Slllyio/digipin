"""Groundwater stress by district: CGWB's Dynamic Ground Water Resources 2025 (via OpenCity, public domain).

The Central Ground Water Board's national compilation for 2025 gives, per district, the annual recharge, the
extractable resource, what is pumped for irrigation, industry and homes, and the stage of extraction (pumping as a
share of the extractable resource; over 100% means the aquifer is being mined). Per lived-in L7 block (dataset
``gw_district``), from the block's NFHS district (``nfhs.district``, 2011 boundaries):

    gw_stage_pct        stage of groundwater extraction, 2025 (%)
    gw_class            1 safe (up to 70%), 2 semi-critical (70-90), 3 critical (90-100), 4 over-exploited (over 100)
    gw_domestic_pct / gw_industry_pct / gw_irrigation_pct   share of extraction by use
    gw_recharge_ham     total annual recharge (hectare-metres); gw_extraction_ham  total annual extraction
    gw_state_stage_pct  the state's stage of extraction

States with district tables: Delhi, Karnataka, Maharashtra, Tamil Nadu, Telangana and Gujarat. Districts split since
2011 take the value of the district that keeps the 2011 name (Delhi's Shahdara and South East are folded into their
2011 parents, Ranga Reddy and Kancheepuram use today's smaller districts).

    python -m pipeline.realestate.gwstress --region all
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
B = "https://data.opencity.in/dataset/3e28a58b-22d4-4f6a-89ac-9738693eb745/resource/"
FILES = {   # the TN and TG file names are swapped on OpenCity; states are told apart by their districts
    "Delhi": "8e39cc66-06a4-417b-8a4f-dbd4a9495ed6/download/del_gw_2025.csv",
    "Karnataka": "9f5bad83-69fd-4f61-a501-c5c7fc9d22d5/download/kar_gw_2025.csv",
    "Maharashtra": "ec046422-448d-4ceb-b422-59d85fa54986/download/mh_gw_2025.csv",
    "Tamil Nadu": "d8c4c53b-5c73-459c-b137-11c51e8fe8e0/download/tn_gw_2025.csv",
    "Telangana": "8000309b-59d7-4b5e-aeb1-befaaab9c0f8/download/tg_gw_2025.csv",
    "Gujarat": "f64c4019-ba33-4435-9d07-290ade3c398e/download/guj_gw_2025.csv",
}
# NFHS (2011) district name -> CGWB 2025 name, where they differ
ALIAS = {"bangalore": "bengaluru (urban)", "bangalore rural": "bengaluru (rural)", "mumbai suburban": "mumbai sub",
         "raigarh": "raigad", "thiruvallur": "tiruvallur", "ranga reddy": "rangareddy"}


def norm(s):
    s = re.sub(r"\s+", " ", str(s or "").strip().lower())
    return ALIAS.get(s, s)


def _f(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def klass(stage):
    return None if stage is None else 1 if stage <= 70 else 2 if stage <= 90 else 3 if stage <= 100 else 4


def districts(rows):
    """({district: fields}, state stage %) from one state's table."""
    out, state = {}, None
    for r in rows:
        name = (r.get("Name of District") or "").strip()
        col = lambda pre: next((_f(v) for k, v in r.items() if k and k.strip().startswith(pre)), None)
        stage = col("Stage of GW extraction")
        if not name or stage is None:
            continue
        if name.lower().startswith("total"):
            state = stage
            continue
        tot = col("Total Annual Extraction")
        f = {"gw_stage_pct": round(stage, 1), "gw_class": klass(stage), "gw_recharge_ham": col("Total annual groundwater recharge"),
             "gw_extraction_ham": tot}
        for k, pre in (("domestic", "Domestic"), ("industry", "Industrial"), ("irrigation", "Irrigation")):
            v = col(pre)
            if tot and v is not None:
                f[f"gw_{k}_pct"] = round(100 * v / tot, 1)
        out[norm(name)] = {k: v for k, v in f.items() if v is not None}
    return out, state


def block_rows(district_of, tables):
    """{code: fields} for blocks whose NFHS district matches a district in any state table."""
    rows = {}
    for code, d in district_of.items():
        for dist, state in tables.values():
            f = dist.get(norm(d))
            if f:
                rows[code] = dict(f, **({"gw_state_stage_pct": round(state, 1)} if state is not None else {}))
                break
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pct = lambda k, label: FieldSpec(k, label, agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None)
    specs = [
        FieldSpec("gw_stage_pct", "Stage of groundwater extraction, district 2025", agg="mean", unit="%", domain=[0, 200], ramp="reds", higher_is="worse"),
        FieldSpec("gw_class", "Groundwater category (1 safe, 2 semi-critical, 3 critical, 4 over-exploited)", agg="max", ramp="reds", higher_is="worse"),
        pct("gw_domestic_pct", "Share of groundwater pumped for homes"),
        pct("gw_industry_pct", "Share of groundwater pumped for industry"),
        pct("gw_irrigation_pct", "Share of groundwater pumped for irrigation"),
        FieldSpec("gw_recharge_ham", "District annual groundwater recharge", agg="max", unit="ha·m", ramp="viridis", higher_is="better"),
        FieldSpec("gw_extraction_ham", "District annual groundwater extraction", agg="max", unit="ha·m", ramp="reds", higher_is="worse"),
        FieldSpec("gw_state_stage_pct", "Stage of groundwater extraction, whole state 2025", agg="mean", unit="%", domain=[0, 200], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="gw_district", title="Groundwater stress by district (CGWB 2025)", level=LEVEL, fields=specs, group="Environment",
        description="The Central Ground Water Board's 2025 assessment per district: stage of extraction (pumping as a share of the "
                    "extractable resource), its category, recharge, extraction and the split between homes, industry and "
                    "irrigation, via data.opencity.in. Joined through the block's NFHS (2011) district; Delhi, Karnataka, "
                    "Maharashtra, Tamil Nadu, Telangana and Gujarat.",
        source="pipeline/realestate/gwstress.py (CGWB Dynamic Ground Water Resources of India 2025 district tables via OpenCity)",
        license="Public domain (CGWB via data.opencity.in)", default_field="gw_stage_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline.realestate.assembly import _column
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="ahmedabad,bengaluru,chennai,delhi,hyderabad,mumbai,pune")
    tables = {s: districts(csv.DictReader(io.StringIO(requests.get(B + u, timeout=120).content.decode("utf-8-sig"))))
              for s, u in FILES.items()}
    for region in ap.parse_args(argv).region.split(","):
        col = _column(region, "nfhs", "district")
        if not col:
            print(f"{region}: no nfhs districts")
            continue
        rows = block_rows({c: d for c, d in zip(col[0], col[1][0]) if d}, tables)
        if not rows:
            print(f"{region}: no district matched")
            continue
        cell_dataset(region, rows)
        st = sorted({(r["gw_stage_pct"]) for r in rows.values()})
        print(f"{region}: {len(rows)} of {len(col[0])} blocks, stages {st}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
