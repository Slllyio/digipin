"""Is the city emitting more soot than it used to: EDGAR's emissions by urban centre, 1975-2024 (European Commission JRC, CC BY 4.0).

The JRC adds up its EDGAR emission grids over each of the world's 11,422 urban centres in the GHSL Urban Centre Database
(``EDGAR_GHG_AP_by_UCDB_2026.xlsx``, 2025 release), by sector and for 1975, 1980, ... 2020 and 2024. Only the air pollutant
columns are used here (PM2.5 and NOx, CC BY 4.0): the fossil CO2 and GHG columns build on IEA data under CC BY-NC-ND and
are left out. An urban centre is the GHSL's dense built-up blob (Delhi's runs from Sonipat to Faridabad and Noida, Kolkata's
spans both banks of the Hooghly), not the municipal area, and its population is the 2025 GHSL estimate. Per city (dataset
``city_emissions``, one value per city copied to every lived-in L7 block):

    ce_pm25_t           PM2.5 emitted in 2024 (tonnes)
    ce_pm25_2000_pct    change since 2000 (%)
    ce_pm25_kg_pp       kg per resident in 2024 (2025 population)
    ce_pm25_vs_india    that against the median of India's 1,925 urban centres (x)
    ce_nox_t            NOx emitted in 2024 (tonnes)
    ce_nox_2000_pct     change since 2000 (%)
    ce_homes_pct        household fuel's share of the PM2.5 in 2024 (%)
    ce_homes_2000_pct   the same share in 2000 (%)
    ce_industry_pct     industry's share of the PM2.5 in 2024 (%)

    python -m pipeline.realestate.cityemissions [--xlsx local copy]
"""
from __future__ import annotations

import argparse
import statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/EDGAR/datasets/edgar_cities/EDGAR_GHG_AP_by_UCDB_2026.xlsx"
SHEET = "EDGAR_GHG_AP_by_city_2025"
SECTORS = ("Agriculture", "Energy", "Industry", "International", "Residential", "Transport", "Waste")
NOW, THEN = 2024, 2000
CITY = {"ahmedabad": "Ahmedabad", "bengaluru": "Bengaluru", "bhopal": "Bhopal", "chennai": "Chennai", "delhi": "New Delhi",
        "guna": "Guna", "hyderabad": "Hyderabad", "indore_pilot": "Indore", "jaipur": "Jaipur", "kolkata": "Kolkata",
        "lucknow": "Lucknow", "mumbai": "Mumbai", "pune": "Pune"}


def total(row, gas, year, sectors=SECTORS):
    return sum(row.get(f"EMI_{gas}_{s}_{year}") or 0 for s in sectors)


def figures(row, india_median_kg):
    pm, pm0, nx, nx0 = total(row, "PM2.5", NOW), total(row, "PM2.5", THEN), total(row, "NOx", NOW), total(row, "NOx", THEN)
    pop = row.get("GC_POP_TOT_2025") or 0
    f = {"ce_pm25_t": round(pm), "ce_nox_t": round(nx)}
    if pm0:
        f["ce_pm25_2000_pct"] = round(100 * (pm / pm0 - 1))
        f["ce_homes_2000_pct"] = round(100 * (row.get(f"EMI_PM2.5_Residential_{THEN}") or 0) / pm0)
    if nx0:
        f["ce_nox_2000_pct"] = round(100 * (nx / nx0 - 1))
    if pm:
        f["ce_homes_pct"] = round(100 * (row.get(f"EMI_PM2.5_Residential_{NOW}") or 0) / pm)
        f["ce_industry_pct"] = round(100 * (row.get(f"EMI_PM2.5_Industry_{NOW}") or 0) / pm)
    if pop:
        f["ce_pm25_kg_pp"] = round(1000 * pm / pop, 2)
        if india_median_kg:
            f["ce_pm25_vs_india"] = round(1000 * pm / pop / india_median_kg, 1)
    return f


def read_rows(path):
    import openpyxl
    ws = openpyxl.load_workbook(path, read_only=True)[SHEET]
    it = ws.iter_rows(values_only=True)
    head = next(it)
    return [dict(zip(head, r)) for r in it]


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, better="worse": FieldSpec(k, label, agg="max", unit=unit, ramp="reds", higher_is=better)
    specs = [
        v("ce_pm25_t", "PM2.5 emitted in the urban centre, 2024", "t"),
        v("ce_pm25_2000_pct", "Change in PM2.5 emitted since 2000", "%"),
        v("ce_pm25_kg_pp", "PM2.5 emitted per resident, 2024", "kg"),
        v("ce_pm25_vs_india", "PM2.5 per resident against the median Indian urban centre", "×"),
        v("ce_nox_t", "NOx emitted in the urban centre, 2024", "t"),
        v("ce_nox_2000_pct", "Change in NOx emitted since 2000", "%"),
        v("ce_homes_pct", "Household fuel's share of PM2.5 emitted, 2024", "%", None),
        v("ce_homes_2000_pct", "Household fuel's share of PM2.5 emitted, 2000", "%", None),
        v("ce_industry_pct", "Industry's share of PM2.5 emitted, 2024", "%", None),
    ]
    spec = DatasetSpec(
        id="city_emissions", title="City soot and NOx emissions since 2000 (EDGAR by urban centre)", level=LEVEL, fields=specs,
        group="Environment",
        description="PM2.5 and NOx emitted in the city's GHSL urban centre in 2024 and 2000, per resident and by sector, from the "
                    "European Commission JRC's EDGAR emissions by urban centre (2025 release). One value per city.",
        source="pipeline/realestate/cityemissions.py (EDGAR_GHG_AP_by_UCDB_2026.xlsx, PM2.5 and NOx columns only)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, EDGAR emissions by city, edgar.jrc.ec.europa.eu/edgar_cities)",
        default_field="ce_pm25_kg_pp", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import tempfile

    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--xlsx", help="local copy of EDGAR_GHG_AP_by_UCDB_2026.xlsx")
    a = ap.parse_args(argv)
    path = a.xlsx
    if not path:
        tmp = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
        tmp.write(requests.get(URL, timeout=600).content)
        tmp.close()
        path = tmp.name
    india = [r for r in read_rows(path) if r.get("GC_CNT_GAD_2025") == "India"]
    med = statistics.median(1000 * total(r, "PM2.5", NOW) / r["GC_POP_TOT_2025"] for r in india if r.get("GC_POP_TOT_2025"))
    by_name = {r["GC_UCN_MAI_2025"]: r for r in india}
    for region, name in CITY.items():
        if name not in by_name:
            continue
        f = figures(by_name[name], med)
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    print(f"median Indian urban centre: {med:.2f} kg PM2.5 per resident ({len(india)} centres)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
