"""District development indicators from the state economic surveys (via OpenCity, public domain).

Per lived-in L7 block (dataset ``district_dev``), from the block's NFHS district (``nfhs.district``, 2011 names).
Maharashtra (Economic Survey 2025-26, district statistics; Mumbai, Pune):

    dd_schools_lakh      schools per lakh people (2024-25)
    dd_ptr_elem          pupils per teacher, Std I-VII (2024-25)
    dd_elec_home_kwh / dd_elec_comm_kwh / dd_elec_ind_kwh   electricity used per head by homes, shops and offices,
                         and industry (kWh a year, 2024-25)
    dd_atms_lakh         ATMs per lakh people (December 2025);  dd_banks_lakh  bank branches per lakh people
    dd_deposit_pc / dd_credit_pc   bank deposits and credit per head (₹, 2024-25);  dd_cd_ratio  credit-deposit ratio (%)
    dd_factories / dd_factory_workers   registered factories in operation and their workers (ASI 2023-24)
    dd_vehicles_lakh     motor vehicles per lakh people (2024-25)
    dd_imr               infant deaths per 1,000 births (2024-25)
    dd_underweight_pct   children under 5 underweight, moderate or severe (%, 2024-25)

Karnataka (Economic Survey 2025-26; Bengaluru):

    dd_msme_units / dd_msme_jobs   registered micro, small and medium enterprises and the jobs they report (2025)
    dd_eshram_pct        unorganised workers registered on eShram, % of the district's target (2025)
    dd_sslc_pass_pct     Class 10 (SSLC) pass rate, 2025;  dd_sslc_pass_2024  the 2024 rate

Only district totals are read; the scheme tables split by caste or by person are not.

    python -m pipeline.realestate.districtdev --region mumbai,pune,bengaluru
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
OC = "https://data.opencity.in/dataset/"
MH = OC + "e7bbb682-6685-4176-b440-d4bf04dab380/resource/cb2d1454-da09-4816-92cf-f64eff4bd3b6/download/district_statistics_combined.csv"
KA = OC + "699b7b8d-3813-4e44-8d70-cfdf1414ee85/resource/"
KA_PACKAGE = "699b7b8d-3813-4e44-8d70-cfdf1414ee85"
# field -> Maharashtra column
MH_COLS = {
    "dd_schools_lakh": "Number of Schools per Lakh Population 2024-25",
    "dd_ptr_elem": "Pupil Teacher Ratio Elementary Std I-VII 2024-25",
    "dd_elec_home_kwh": "Per Capita Domestic Consumption of Electricity kwh 2024-25",
    "dd_elec_comm_kwh": "Per Capita Commercial Consumption of Electricity kwh 2024-25",
    "dd_elec_ind_kwh": "Per Capita Industrial Consumption of Electricity kwh 2024-25",
    "dd_atms_lakh": "Number ATMs per Lakh Population as on 31/12/2025",
    "dd_banks_lakh": "Number of Banking Offices per Lakh Population 2024-25",
    "dd_deposit_pc": "Per Capita Deposit Rs 2024-25",
    "dd_credit_pc": "Per Capita Credit Rs 2024-25",
    "dd_cd_ratio": "Credit Deposit Ratio 2024-25",
    "dd_factories": "Factories in Operation no. ASI 2023-24",
    "dd_factory_workers": "Workers no. ASI 2023-24",
    "dd_vehicles_lakh": "Motor Vehicles per Lakh Population 2024-25",
    "dd_imr": "Infant Mortality per Thousand Births 2024-25",
}
UNDERWEIGHT = ("Percentage of Severely Underweight Children 0-5 Years 2024-25", "Percentage of Moderately Underweight Children 0-5 Years 2024-25")
# NFHS (2011) district name -> the surveys' name, where they differ (applied at lookup only)
ALIAS = {"mumbai": "mumbai city", "raigarh": "raigad", "bangalore": "bengaluru urban", "bangalore rural": "bengaluru rural"}
# Karnataka's SSLC table is by educational district; these make up Bengaluru Urban
EDU = {"bengaluru north": "bengaluru urban", "bengaluru south": "bengaluru urban"}


def clean(s):
    s = re.sub(r"[()#$*+]", "", str(s or "")).replace("\n", " ")
    return re.sub(r"\s+", " ", s).strip().lower()


def norm(s):
    s = clean(s)
    return ALIAS.get(s, s)


def _f(x):
    s = str(x or "").replace(",", "").strip()
    if s.startswith("(-)"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def mh_table(rows):
    out = {}
    for r in rows:
        name = clean(r.get("District"))
        if not name:
            continue
        f = {k: _f(r.get(c)) for k, c in MH_COLS.items()}
        uw = [_f(r.get(c)) for c in UNDERWEIGHT]
        if all(v is not None for v in uw):
            f["dd_underweight_pct"] = round(sum(uw), 1)
        out[name] = {k: v for k, v in f.items() if v is not None}
    return out


def ka_table(msme, eshram, sslc):
    """{district: fields} from Karnataka's MSME, eShram and SSLC tables (SSLC summed over educational districts)."""
    out = {}
    put = lambda name, **kv: out.setdefault(clean(name), {}).update(kv)
    for r in msme:
        u, j = _f(r.get("Total Enterprises")), _f(r.get("Total Employed"))
        if r.get("District") and u is not None:
            put(r["District"], dd_msme_units=u, **({"dd_msme_jobs": j} if j is not None else {}))
    for r in eshram:
        p = _f(r.get("Percentage"))
        if r.get("District") and p is not None:
            put(r["District"], dd_eshram_pct=round(p, 1))
    acc, seen = {}, set()
    for r in sslc:
        name = clean(r.get("District Name"))
        if not name or name in seen or name == "total":
            continue
        seen.add(name)
        a = acc.setdefault(EDU.get(name, name), [0, 0, 0, 0])
        for k, c in enumerate(("2025 Appeared", "2025 Passed", "2024 appeared", "2024 passed")):
            a[k] += _f(r.get(c)) or 0
    for name, (a25, p25, a24, p24) in acc.items():
        if a25:
            put(name, dd_sslc_pass_pct=round(100 * p25 / a25, 1), **({"dd_sslc_pass_2024": round(100 * p24 / a24, 1)} if a24 else {}))
    return out


def block_rows(district_of, tables):
    rows = {}
    for code, d in district_of.items():
        for t in tables:
            f = t.get(norm(d))
            if f:
                rows[code] = dict(f)
                break
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    F = lambda k, label, unit=None, higher=None, agg="mean": FieldSpec(k, label, agg=agg, unit=unit, ramp="viridis", higher_is=higher)
    specs = [
        F("dd_schools_lakh", "Schools per lakh people, district 2024-25", "per lakh", "better"),
        F("dd_ptr_elem", "Pupils per teacher, Std I-VII, district 2024-25", "pupils", "worse"),
        F("dd_elec_home_kwh", "Electricity used by homes per head, district 2024-25", "kWh/yr"),
        F("dd_elec_comm_kwh", "Commercial electricity use per head, district 2024-25", "kWh/yr"),
        F("dd_elec_ind_kwh", "Industrial electricity use per head, district 2024-25", "kWh/yr"),
        F("dd_atms_lakh", "ATMs per lakh people, district Dec 2025", "per lakh", "better"),
        F("dd_banks_lakh", "Bank branches per lakh people, district 2024-25", "per lakh", "better"),
        F("dd_deposit_pc", "Bank deposits per head, district 2024-25", "₹"),
        F("dd_credit_pc", "Bank credit per head, district 2024-25", "₹"),
        F("dd_cd_ratio", "Credit-deposit ratio, district 2024-25", "%"),
        F("dd_factories", "Registered factories in operation, district (ASI 2023-24)", "factories", agg="max"),
        F("dd_factory_workers", "Workers in registered factories, district (ASI 2023-24)", "workers", agg="max"),
        F("dd_vehicles_lakh", "Motor vehicles per lakh people, district 2024-25", "per lakh"),
        F("dd_imr", "Infant deaths per 1,000 births, district 2024-25", "per 1,000", "worse"),
        F("dd_underweight_pct", "Children under 5 underweight, district 2024-25", "%", "worse"),
        F("dd_msme_units", "Registered micro, small and medium enterprises, district 2025", "units", agg="max"),
        F("dd_msme_jobs", "Jobs reported by registered MSMEs, district 2025", "jobs", agg="max"),
        F("dd_eshram_pct", "Unorganised workers registered on eShram, % of target", "%"),
        F("dd_sslc_pass_pct", "Class 10 (SSLC) pass rate, district 2025", "%", "better"),
        F("dd_sslc_pass_2024", "Class 10 (SSLC) pass rate, district 2024", "%", "better"),
    ]
    spec = DatasetSpec(
        id="district_dev", title="District development indicators (state economic surveys)", level=LEVEL, fields=specs, group="Real estate",
        description="Schools, teachers, electricity use, banking, factories, vehicles and child health for the block's district from "
                    "the Economic Survey of Maharashtra 2025-26, and registered small businesses, eShram sign-ups and Class 10 "
                    "pass rates from the Economic Survey of Karnataka 2025-26, via data.opencity.in. Joined through the NFHS "
                    "(2011) district.",
        source="pipeline/realestate/districtdev.py (state economic survey district tables via OpenCity)",
        license="Public domain (state governments via data.opencity.in)", default_field="dd_banks_lakh", extrude=False)
    clean_rows = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean_rows, LEVEL, specs), parquet=False)


def fetch(url):
    import requests
    return list(csv.DictReader(io.StringIO(requests.get(url, timeout=120).content.decode("utf-8-sig"))))


def main(argv=None):
    import requests
    from pipeline.realestate.assembly import _column
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="mumbai,pune,bengaluru")
    res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": KA_PACKAGE}, timeout=60).json()["result"]["resources"]
    url = lambda part: next(r["url"] for r in res if r["url"].endswith(part))
    tables = [mh_table(fetch(MH)),
              ka_table(fetch(url("ka-district-msme-employment-2025.csv")), fetch(url("ka-eshram-unorganised-workers-2025.csv")),
                       fetch(url("ka-sslc-2024-25.csv")))]
    for region in ap.parse_args(argv).region.split(","):
        col = _column(region, "nfhs", "district")
        rows = block_rows({c: d for c, d in zip(col[0], col[1][0]) if d}, tables) if col else {}
        if not rows:
            print(f"{region}: no district matched")
            continue
        cell_dataset(region, rows)
        print(f"{region}: {len(rows)} of {len(col[0])} blocks, {sorted({tuple(sorted(r.items()))[:3] for r in rows.values()})}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
