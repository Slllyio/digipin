"""District income per head from the state economic surveys (via OpenCity, public domain).

Per lived-in L7 block (dataset ``district_income``), from the block's NFHS district (``nfhs.district``, 2011 names):

    di_pci        per capita income of the district, current prices (₹ a year; net district domestic product per head)
    di_gddp_cr    gross district domestic product, current prices (₹ crore)
    di_year       the financial year the figures are for (2024 = 2024-25)
    di_rank       the district's rank by per capita income in its state (1 = highest)
    di_districts  districts ranked in that state
    di_pci_median the median district's per capita income in the state

Sources: Economic Survey of Karnataka 2025-26 (district table, 2024-25), Economic Survey of Maharashtra 2025-26
(2024-25 first revised estimates; Mumbai covers the city and suburban districts, Thane includes Palghar), Tamil Nadu
district GDDP 2023-24 and Telangana Socio-Economic Outlook 2024 (2022-23). Each state uses its own method and year,
so compare districts within a state. Districts split since 2011 take their namesake's value.

    python -m pipeline.realestate.districtincome --region bengaluru,mumbai,pune,chennai,hyderabad
"""
from __future__ import annotations

import argparse
import csv
import io
import re
import statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OC = "https://data.opencity.in/dataset/"
# state -> (url, year, district column, per capita column, GDDP column, GDDP divisor to ₹ crore)
SOURCES = {
    "Karnataka": (OC + "699b7b8d-3813-4e44-8d70-cfdf1414ee85/resource/27684453-1635-4571-b5f1-94c706303037/download/ka_districts-gddp-pci-2025-26.csv",
                  2024, "District", "Per Capita Income (Rs.)", "GDDP Current Prices (Cr.)", 1),
    "Maharashtra": (OC + "e7bbb682-6685-4176-b440-d4bf04dab380/resource/d74b42f7-ba91-4aeb-8ef1-828d42001760/download/gdp_data.csv",
                    2024, "District", "Per Capita Nominal NDDP 2024-25+", "Nominal GDDP 2024-25+", 1),
    "Tamil Nadu": (OC + "375cd901-83a6-48c8-8c5b-b87aadb44731/resource/1a5d5eda-2205-4815-9cf8-78c5e1f40709/download/3f6218b3-5d15-4463-91de-9179b66aa86b.csv",
                   2023, "District", "Per capita Income (in Rupees)", "Gross District Domestic Product", 100),   # ₹ lakh
    "Telangana": (OC + "d123ae3a-8e02-4357-9741-bc56746954c7/resource/9acd8282-8081-4a46-af8b-dbd1ba57adac/download/df37b664-e603-48a8-9c19-7ad4bd628e3f.csv",
                  2022, "District", "PCI (Rs.) Current Prices 2022-23", "GDDP (Cr) at Current Prices 2022-23", 1),
}
# NFHS (2011) district name -> the survey's name, where they differ
ALIAS = {"bangalore": "bangalore urban", "mumbai suburban": "mumbai", "raigarh": "raigad", "thiruvallur": "tiruvallur",
         "ranga reddy": "rangareddy", "medak": "sangareddy"}


def clean(s):
    s = re.sub(r"[#$*+]", "", str(s or "")).replace("\n", " ")
    return re.sub(r"\s+", " ", s).strip().lower()


def norm(s):
    """A block's NFHS district name as the surveys spell it."""
    s = clean(s)
    return ALIAS.get(s, s)


def _f(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def state_table(rows, year, dcol, pcol, gcol, div):
    """{district: fields} with in-state ranks; division, state and note rows are skipped."""
    out = {}
    for r in rows:
        r = {(k or "").replace("\n", " ").strip(): v for k, v in r.items()}
        name, pci = clean(r.get(dcol)), _f(r.get(pcol))
        if not name or pci is None or name in out or name in ("state", "total") or name.endswith(" div."):
            continue
        g = _f(r.get(gcol))
        out[name] = {"di_pci": round(pci), "di_year": year, **({"di_gddp_cr": round(g / div)} if g is not None else {})}
    order = sorted(out, key=lambda k: -out[k]["di_pci"])
    med = statistics.median(f["di_pci"] for f in out.values()) if out else None
    for k, name in enumerate(order):
        out[name].update(di_rank=k + 1, di_districts=len(order), di_pci_median=round(med))
    return out


def block_rows(district_of, tables):
    rows = {}
    for code, d in district_of.items():
        for t in tables.values():
            f = t.get(norm(d))
            if f:
                rows[code] = dict(f)
                break
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("di_pci", "District per capita income, current prices", agg="mean", unit="₹/yr", ramp="viridis", higher_is="better"),
        FieldSpec("di_gddp_cr", "Gross district domestic product, current prices", agg="max", unit="₹ crore", ramp="viridis", higher_is=None),
        FieldSpec("di_year", "Year of the district income figures", agg="max", unit="year", ramp="viridis", higher_is=None),
        FieldSpec("di_rank", "District's rank by per capita income in its state (1 = highest)", agg="min", unit="rank", ramp="viridis", higher_is=None),
        FieldSpec("di_districts", "Districts ranked in the state", agg="max", ramp="viridis", higher_is=None),
        FieldSpec("di_pci_median", "Median district per capita income in the state", agg="mean", unit="₹/yr", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="district_income", title="District income per head (state economic surveys)", level=LEVEL, fields=specs, group="Real estate",
        description="Per capita income and gross domestic product of the block's district, with its rank in the state, from the "
                    "Karnataka and Maharashtra economic surveys 2025-26 (2024-25), Tamil Nadu district GDDP (2023-24) and the "
                    "Telangana Socio-Economic Outlook 2024 (2022-23), via data.opencity.in. Joined through the NFHS (2011) district.",
        source="pipeline/realestate/districtincome.py (state economic survey district tables via OpenCity)",
        license="Public domain (state governments via data.opencity.in)", default_field="di_pci", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline.realestate.assembly import _column
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru,mumbai,pune,chennai,hyderabad")
    tables = {}
    for state, (url, year, dcol, pcol, gcol, div) in SOURCES.items():
        text = requests.get(url, timeout=120).content.decode("utf-8-sig")
        tables[state] = state_table(csv.DictReader(io.StringIO(text)), year, dcol, pcol, gcol, div)
    for region in ap.parse_args(argv).region.split(","):
        col = _column(region, "nfhs", "district")
        rows = block_rows({c: d for c, d in zip(col[0], col[1][0]) if d}, tables) if col else {}
        if not rows:
            print(f"{region}: no district matched")
            continue
        cell_dataset(region, rows)
        print(f"{region}: {len(rows)} of {len(col[0])} blocks, {sorted({(r['di_pci'], r['di_rank']) for r in rows.values()})}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
