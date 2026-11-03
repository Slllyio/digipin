"""How the city's temperatures have changed since 1951: IMD daily temperature series for eight cities (via OpenCity, public domain).

OpenCity republishes India Meteorological Department daily maximum and minimum temperature (and rain) for Delhi,
Kolkata, Mumbai, Chennai, Bengaluru, Ahmedabad, Hyderabad and Pune from 1951 to 2024. Up to 2020 the values read like
IMD's gridded daily series for the city's grid cell (two decimals, no gaps); from 2021 they switch to another source
(Mumbai's mean minimum jumps 2 °C in one year, Pune's drops 2.3 °C, rain totals change level), so only 1951-2020 is
used. The rain column is not used at all: before 2021 Pune's grid cell gets 1,500-4,300 mm a year, the Ghats rather
than the city, and Mumbai and Chennai have no rain before 2021. Comparing the 1991-2020 normal period with 1951-1980
(dataset ``city_climate``, one value per city, copied to every lived-in L7 block):

    cc_tmax_change    change in the mean daily maximum (°C)
    cc_tmin_change    change in the mean daily minimum (°C)
    cc_hot_then / cc_hot_now      days a year hotter than the 1951-1980 hottest 5% of days (about 18 a year then)
    cc_warm_nights_now            nights a year warmer than the 1951-1980 warmest 5% of nights
    cc_40_then / cc_40_now        days a year at 40 °C or more
    cc_last_year                  last year used (2020, or earlier where the series stops)

Days with a missing value are skipped, and years with under 300 readings are left out of the averages.

    python -m pipeline.realestate.climaterecord
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
B = "https://data.opencity.in/dataset/e57cd149-fd78-4853-80b8-47d3d082845e/resource/"
URLS = {
    "delhi": "0c853240-47a3-428c-bb5e-933e74245e08/download/82da1ebe-c0d6-45c4-9785-1e1ab0a9ec3f.csv",
    "mumbai": "61e2fec8-cbab-4a35-8bc3-ee7824330bb9/download/5e1509d4-1808-4003-bff5-05cc72b65281.csv",
    "chennai": "56df10c7-cd7e-4c7a-950c-96aec31a0e57/download/320fa3c6-0de0-42bc-a0ca-ac25666e8d55.csv",
    "bengaluru": "9cf80863-97ea-4ad8-a4ef-6a5f026debbb/download/ae01b010-feb0-41ad-959e-83480a9d98c3.csv",
    "ahmedabad": "db3f6c55-bc4e-4e12-be01-49448686596b/download/877f72ae-d064-4a98-94b6-78db558204f6.csv",
    "hyderabad": "9446cd01-1759-41d3-8918-86297d43c625/download/e83ee52a-c17e-46da-9566-0ab317d545b4.csv",
    "pune": "7a654494-2597-4405-8eb4-f0db760f1c1b/download/291ea394-8201-4064-8b8b-9de612edb1c0.csv",
    "kolkata": "2f2fd6a8-cfad-4648-989c-08272d01982b/download/d95a278d-d655-414a-b791-f937c779b950.csv",
}
THEN, NOW = (1951, 1980), (1991, 2020)
LAST = 2020                 # the series changes source in 2021
MIN_DAYS = 300


def _date(s):
    s = (s or "").strip()
    if re.fullmatch(r"\d{1,2}-\d{1,2}-\d{4}", s):
        d, m, y = map(int, s.split("-"))
        return dt.date(y, m, d)
    if re.fullmatch(r"\d{5}", s):                       # a few rows carry Excel serial dates
        return dt.date(1899, 12, 30) + dt.timedelta(days=int(s))
    return None


def _f(x):
    try:
        v = float(str(x).strip())
    except ValueError:
        return None
    return v if -20 < v < 1000 else None


def days(rows):
    """[(date, rain, tmax, tmin)] with None for missing values."""
    out = []
    for r in rows:
        d = _date(r.get("Date"))
        if d:
            out.append((d, _f(r.get("Rain")), _f(r.get("Temp Max")), _f(r.get("Temp Min"))))
    return out


def _q95(vals):
    v = sorted(vals)
    return v[min(len(v) - 1, int(0.95 * len(v)))]


def figures(ds):
    """Then-versus-now figures from the daily rows."""
    def span(lo, hi):
        return [x for x in ds if lo <= x[0].year <= hi]

    def per_year(rows, idx, test):
        by = {}
        for x in rows:
            if x[idx] is not None:
                n, k = by.get(x[0].year, (0, 0))
                by[x[0].year] = (n + 1, k + (1 if test(x[idx]) else 0))
        ok = [(n, k) for n, k in by.values() if n >= MIN_DAYS]
        return sum(k * 365.25 / n for n, k in ok) / len(ok) if ok else None

    def mean(rows, idx):
        v = [x[idx] for x in rows if x[idx] is not None]
        return sum(v) / len(v) if v else None

    a, b = span(*THEN), span(*NOW)
    hot = _q95([x[2] for x in a if x[2] is not None])
    warm = _q95([x[3] for x in a if x[3] is not None])
    r = lambda v, k=1: None if v is None else round(v, k)
    full = [y for y in {x[0].year for x in ds if x[0].year <= LAST} if sum(1 for x in ds if x[0].year == y and x[2] is not None) >= MIN_DAYS]
    f = {
        "cc_tmax_change": r(mean(b, 2) - mean(a, 2), 2), "cc_tmin_change": r(mean(b, 3) - mean(a, 3), 2),
        "cc_hot_then": r(per_year(a, 2, lambda v: v > hot)), "cc_hot_now": r(per_year(b, 2, lambda v: v > hot)),
        "cc_warm_nights_now": r(per_year(b, 3, lambda v: v > warm)),
        "cc_40_then": r(per_year(a, 2, lambda v: v >= 40)), "cc_40_now": r(per_year(b, 2, lambda v: v >= 40)),
        "cc_last_year": max(full) if full else None,
    }
    return {k: v for k, v in f.items() if v is not None}


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda key, label, unit, better="worse": FieldSpec(key, label, agg="max", unit=unit, ramp="reds", higher_is=better)
    specs = [
        v("cc_tmax_change", "Change in mean daily maximum, 1991-2020 vs 1951-1980", "°C"),
        v("cc_tmin_change", "Change in mean daily minimum, 1991-2020 vs 1951-1980", "°C"),
        v("cc_hot_then", "Unusually hot days a year, 1951-1980 (hottest 5% of that period)", "days"),
        v("cc_hot_now", "Unusually hot days a year, 1991-2020 (by the 1951-1980 yardstick)", "days"),
        v("cc_warm_nights_now", "Unusually warm nights a year, 1991-2020 (by the 1951-1980 yardstick)", "nights"),
        v("cc_40_then", "Days a year at 40 °C or more, 1951-1980", "days"),
        v("cc_40_now", "Days a year at 40 °C or more, 1991-2020", "days"),
        v("cc_last_year", "Last year used", "year", None),
    ]
    spec = DatasetSpec(
        id="city_climate", title="The city's temperatures since 1951 (IMD daily series)", level=LEVEL, fields=specs, group="Environment",
        description="Daily maximum and minimum temperature for the city's grid cell from 1951 to 2020 (India "
                    "Meteorological Department, via data.opencity.in), the 1991-2020 normal compared with 1951-1980. One "
                    "value per city.",
        source="pipeline/realestate/climaterecord.py (IMD daily temperature 1951-2020 via OpenCity)",
        license="Public domain (India Meteorological Department via data.opencity.in)", default_field="cc_tmax_change", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(URLS))
    for region in ap.parse_args(argv).region.split(","):
        rows = csv.DictReader(io.StringIO(requests.get(B + URLS[region], timeout=180).content.decode("utf-8-sig")))
        fig = figures(days(rows))
        info = cell_dataset(region, fig)
        print(region, fig, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
