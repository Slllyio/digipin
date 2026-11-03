"""District health and household indicators from NFHS-5 (2019-21), spread to every block of the district.

Per L7 block (dataset ``nfhs``): the block's district value of each indicator in FIELDS (children stunted and wasted,
anaemia, obesity, raised blood pressure and blood sugar, clean cooking fuel, sanitation, health insurance, women's
schooling, full vaccination, institutional births) and ``district`` (the NFHS district name).

Values are the IIPS / Ministry of Health NFHS-5 district fact sheets, as converted to CSV with 2011 census district
boundaries by github.com/SaiSiddhardhaKalla/NFHS (phase-1 states via github.com/pratapvardhan/NFHS-5, CC BY 4.0).
Every block in a district gets the same value: these are district averages from a household survey (about 900
households a district), not block measurements. Districts carved out after 2011 (Delhi's Shahdara and South East,
Hyderabad's Medchal-Malkajgiri) fall inside their 2011 parent's boundary and take the parent's values.

    python -m pipeline.realestate.nfhs --region all
"""
from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RAW = "https://raw.githubusercontent.com/SaiSiddhardhaKalla/NFHS/main/"

# field -> (indicator text prefix in the CSV, label, higher_is)
FIELDS = {
    "stunted_pct": ("Children under 5 years who are stunted", "Children under 5 stunted (district)", "worse"),
    "wasted_pct": ("Children under 5 years who are wasted", "Children under 5 wasted (district)", "worse"),
    "child_anaemia_pct": ("Children age 6-59 months who are anaemic", "Children 6-59 months anaemic (district)", "worse"),
    "women_anaemia_pct": ("All women age 15-49 years who are anaemic", "Women 15-49 anaemic (district)", "worse"),
    "women_obese_pct": ("Women who are overweight or obese", "Women overweight or obese (district)", "worse"),
    "bp_women_pct": ("Female Elevated blood pressure or taking medicine", "Women with raised blood pressure (district)", "worse"),
    "bp_men_pct": ("Male Elevated blood pressure or taking medicine", "Men with raised blood pressure (district)", "worse"),
    "sugar_women_pct": ("Female Blood sugar level  high or very high", "Women with high blood sugar (district)", "worse"),
    "sugar_men_pct": ("Male Blood sugar level  high or very high", "Men with high blood sugar (district)", "worse"),
    "clean_fuel_pct": ("Households using clean fuel for cooking", "Households cooking with clean fuel (district)", "better"),
    "sanitation_pct": ("Population living in households that use an improved sanitation", "People with improved sanitation (district)", "better"),
    "insurance_pct": ("Households with any usual member covered under a health insurance", "Households with health insurance (district)", "better"),
    "women_school10_pct": ("Women with 10 or more years of schooling", "Women with 10+ years of school (district)", "better"),
    "full_vacc_pct": ("Children age 12-23 months fully vaccinated based on information from either", "Children 12-23 months fully vaccinated (district)", "better"),
    "inst_births_pct": ("Institutional births (%)", "Institutional births (district)", "better"),
}


def _num(s):
    try:
        return float(str(s).replace("*", "").replace(",", "").strip("() "))
    except ValueError:
        return None


def table(text):
    """{DISTRICT key: {field: value}} from India.csv."""
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        ind = r.get("Indicator") or ""
        for f, (pre, _, _) in FIELDS.items():
            if ind.startswith(pre):
                v = _num(r.get("NFHS 5"))
                if v is not None and v > 0:          # the conversion writes missing values as 0
                    out.setdefault(r["DISTRICT"], {"district": r["District"].strip()})[f] = v
    return out


def fetch(region, values, geo):
    import duckdb

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.powerplants import lived_cells
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE d (k VARCHAR, geom GEOMETRY)")
    feats = [f for f in geo["features"] if f.get("geometry")]
    con.executemany("INSERT INTO d VALUES (?, ST_MakeValid(ST_GeomFromGeoJSON(?)))", [(f["properties"]["DISTRICT"], json.dumps(f["geometry"])) for f in feats])
    con.execute(f"DELETE FROM d WHERE NOT ST_Intersects(geom, ST_MakeEnvelope({w}, {s}, {e}, {n}))")
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", lived_cells(region))
    hits = con.execute("SELECT c.code, min(d.k) FROM c JOIN d ON ST_Contains(d.geom, ST_Point(c.x, c.y)) GROUP BY 1").fetchall()
    return {code: values[k] for code, k in hits if k in values}


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec(f, label, agg="mean", unit="%", domain=[0, 100], ramp="reds" if hi == "worse" else "greens", higher_is=hi)
             for f, (_, label, hi) in FIELDS.items()]
    specs.append(FieldSpec("district", "NFHS-5 district", type="category", agg="mode"))
    spec = DatasetSpec(
        id="nfhs", title="District health and households (NFHS-5)", level=LEVEL, fields=specs, group="Health",
        description="National Family Health Survey 2019-21 district fact sheets (IIPS and the Ministry of Health): child stunting, "
                    "wasting and anaemia, women's anaemia and obesity, raised blood pressure and blood sugar, clean cooking fuel, "
                    "sanitation, health insurance, women's schooling, full vaccination and institutional births. Each block takes "
                    "its 2011-census district's value, so these are district survey averages (about 900 households each), not block "
                    "measurements; districts formed since 2011 take their parent's boundary.",
        source="pipeline/realestate/nfhs.py (NFHS-5 fact sheets via github.com/SaiSiddhardhaKalla/NFHS)",
        license="NFHS-5 fact sheets: Government of India (IIPS / MoHFW), published openly; CSV conversion and 2011 district boundaries "
                "from SaiSiddhardhaKalla/NFHS (licence not stated) and pratapvardhan/NFHS-5 (CC BY 4.0)",
        default_field="stunted_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    values = table(requests.get(RAW + "India.csv", timeout=300).content.decode("utf-8-sig"))
    geo = json.loads(requests.get(RAW + "Districts.geojson", timeout=300).content.decode("utf-8-sig"))
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = fetch(r, values, geo)
        print(f"{r}: {len(rows)} blocks in {len({x['district'] for x in rows.values()})} districts")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
