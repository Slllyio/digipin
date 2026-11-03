"""Births and deaths registered each year: Chennai, Delhi and Bengaluru civil registration (via OpenCity, public domain).

The city corporations' birth and death registers give yearly totals: Greater Chennai Corporation 2019-2025, Delhi
2017-2024 (Chief Registrar, all of NCT) and BBMP 2001-2024 (with births by sex). They show the deaths of the 2020 and
2021 COVID waves against the years before, and how births have moved since. One value per city, copied to every
lived-in L7 block (dataset ``city_vitals``):

    vs_year                latest year
    vs_births / vs_deaths  registered in the latest year
    vs_births_base         yearly average of the baseline years (Chennai 2019; Delhi and BBMP 2017-2019)
    vs_births_change_pct   latest year's births against the baseline (%)
    vs_deaths_base         yearly average deaths in the baseline years
    vs_excess_2020_pct / vs_excess_2021_pct   deaths above the baseline (%)
    vs_excess_2021         deaths above the baseline in 2021
    vs_girls_per_1000      girls born per 1,000 boys, latest year (BBMP only)

Registers count events where they happen, so births and deaths in city hospitals of people from outside are included.

    python -m pipeline.realestate.vitalstats --region chennai,delhi,bengaluru
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
B = "https://data.opencity.in/dataset/"
URLS = {
    "chennai": B + "3577dfc8-3753-4663-af15-a4be9cb404b6/resource/789859ee-d9b2-4ec9-ac13-8ac6db940509/download/77d2ff7d-99ae-46f1-94e0-4b039e1a62fa.csv",
    "delhi": B + "81a1888e-61ad-4492-a7da-0382b798caa4/resource/960dee6c-a598-4a0a-bb85-0fd79a0a80c3/download/0ff67794-17d0-4c5b-b9f3-9b3ba71204a3.csv",
    "bengaluru": B + "14c80edf-0ee9-4c86-87e5-05f4de7363b0/resource/a87319d9-0442-4c7d-97db-0dec9d30a577/download/2b29d5ea-8d46-434b-a04c-f449748cd82a.csv",
}
# baseline years before COVID; Chennai's 2018 row covers half a year only
BASE = {"chennai": (2019,), "delhi": (2017, 2018, 2019), "bengaluru": (2017, 2018, 2019)}
BODY = {"chennai": "Greater Chennai Corporation", "delhi": "NCT of Delhi", "bengaluru": "BBMP"}
# region -> (births column, deaths column, girls column, boys column)
COLS = {"chennai": ("Births registered", "Deaths registered", None, None),
        "delhi": ("Births", "Deaths", None, None),
        "bengaluru": ("BBMP Total Births", "BBMP Total Deaths", "BBMP Female Births", "BBMP Male Births")}


def _n(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def years(region, rows):
    """{year: {births, deaths[, girls, boys]}} from the city's CSV rows."""
    b, d, g, m = COLS[region]
    out = {}
    for r in rows:
        y = re.match(r"\s*(\d{4})\s*$", r.get("Year") or "")
        if not y:
            continue
        v = {"births": _n(r.get(b)), "deaths": _n(r.get(d))}
        if g:
            v.update(girls=_n(r.get(g)), boys=_n(r.get(m)))
        out[int(y.group(1))] = {k: x for k, x in v.items() if x is not None}
    return out


def figures(region, ys):
    base = [ys[y] for y in BASE[region] if y in ys]
    latest = max(y for y in ys if "births" in ys[y] and "deaths" in ys[y])
    mean = lambda k: sum(x[k] for x in base) / len(base)
    bb, db = mean("births"), mean("deaths")
    last = ys[latest]
    f = {"vs_year": latest, "vs_births": last["births"], "vs_deaths": last["deaths"], "vs_births_base": round(bb),
         "vs_births_change_pct": round(100 * (last["births"] - bb) / bb, 1), "vs_deaths_base": round(db)}
    for y in (2020, 2021):
        if y in ys and "deaths" in ys[y]:
            f[f"vs_excess_{y}_pct"] = round(100 * (ys[y]["deaths"] - db) / db, 1)
    if 2021 in ys:
        f["vs_excess_2021"] = round(ys[2021]["deaths"] - db)
    if last.get("boys"):
        f["vs_girls_per_1000"] = round(1000 * last["girls"] / last["boys"])
    return f


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda key, label, unit, better=None: FieldSpec(key, label, agg="max", unit=unit, ramp="reds", higher_is=better)
    specs = [
        v("vs_year", "Latest year in the register", "year"),
        v("vs_births", "Births registered in the latest year", "births"),
        v("vs_deaths", "Deaths registered in the latest year", "deaths"),
        v("vs_births_base", "Births a year before COVID (baseline average)", "births"),
        v("vs_births_change_pct", "Births in the latest year against the baseline", "%"),
        v("vs_deaths_base", "Deaths a year before COVID (baseline average)", "deaths"),
        v("vs_excess_2020_pct", "Deaths in 2020 above the baseline", "%", "worse"),
        v("vs_excess_2021_pct", "Deaths in 2021 above the baseline", "%", "worse"),
        v("vs_excess_2021", "Deaths in 2021 above the baseline", "deaths", "worse"),
        v("vs_girls_per_1000", "Girls born per 1,000 boys, latest year", "girls", "better"),
    ]
    spec = DatasetSpec(
        id="city_vitals", title="Births and deaths registered (city registers)", level=LEVEL, fields=specs, group="Health",
        description=f"Yearly births and deaths in the civil register of {BODY.get(region, region)}, with the COVID-year deaths "
                    f"against the years before (via data.opencity.in). One value per city.",
        source="pipeline/realestate/vitalstats.py (city birth and death registers via OpenCity)",
        license="Public domain (city corporations and Delhi's Chief Registrar of Births and Deaths via data.opencity.in)",
        default_field="vs_excess_2021_pct", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(URLS))
    for region in ap.parse_args(argv).region.split(","):
        rows = list(csv.DictReader(io.StringIO(requests.get(URLS[region], timeout=120).content.decode("utf-8-sig"))))
        fig = figures(region, years(region, rows))
        info = cell_dataset(region, fig)
        print(region, fig, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
