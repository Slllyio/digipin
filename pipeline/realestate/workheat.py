"""Days too hot and humid for safe outdoor work, 1983-2016, from NASA SEDAC's Global High Resolution Daily Extreme Urban
Heat Exposure, UHE-Daily (Tuholske et al. 2021, PNAS; CIESIN; CC BY 4.0, commercial use allowed).

UHE-Daily counts, for more than 10,000 urban settlements (GHS-UCDB 2015 outlines), the days each year whose maximum Wet
Bulb Globe Temperature (WBGTmax, from CHIRTS-daily air temperature and humidity) passes the ISO occupational heat-stress
thresholds: above 30 °C heavy work is unsafe without rest breaks, above 32 °C even light work is. It also splits the rise in
person-days of exposure between urban warming (more hot days for the 1983 population) and population growth. Settlements
are matched to each city by nearest centroid within 25 km of the city centre, the most populous one winning; a city with
no row has had no such day. Per city (dataset ``work_heat``, one value per city copied to every lived-in L7 block):

    wh30_early / wh30_late   days a year above WBGTmax 30 °C, 1983-1992 and 2007-2016 averages
    wh32_early / wh32_late   the same above 32 °C
    wh_heat_share            share of the 1983-2016 rise in person-days above 30 °C due to warming, not population (%)
    wh30_india_pctile        share of India's settlements of a million or more with fewer such days in 2007-2016 (%)

Download the csv-json zip (1.9 GB) with Earthdata access; only the *_EXP.csv and *_TREND_ALL.csv files are needed:
https://data.earthdata.nasa.gov/nasa-earth/human-dimensions/sedac-root/downloads/data/sdei/sdei-high-res-daily-uhe-1983-2016/sdei-high-res-daily-uhe-1983-2016-csv-json.zip

    python -m pipeline.realestate.workheat --dir /path/unzipped
"""
from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

from pipeline.realestate.heatisland import CENTRE
from pipeline.realestate.landefficiency import BIG, below_share

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
MATCH_KM = 25
EARLY, LATE = range(1983, 1993), range(2007, 2017)


def km(lng1, lat1, lng2, lat2):
    return math.hypot((lng1 - lng2) * math.cos(math.radians(lat2)), lat1 - lat2) * 111.32


def read_exp(path):
    """-> {settlement id: {'lat', 'lng', 'pop', 'days': {year: n}}} for India."""
    out = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["CTR_MN_NM"] != "India":
                continue
            s = out.setdefault(r["ID_HDC_G0"], {"lat": float(r["GCPNT_LAT"]), "lng": float(r["GCPNT_LON"]),
                                                "pop": float(r["P2016"] or 0), "days": {}})
            s["days"][int(r["year"])] = float(r["tot_days"] or 0)
    return out


def read_trend(path):
    """-> {settlement id: share of the person-day trend due to warming (%), or None}."""
    out = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["CTR_MN_NM"] != "India":
                continue
            p, h = float(r["coef_pdays"] or 0), float(r["coef_heat"] or 0)
            out[r["ID_HDC_G0"]] = round(max(0.0, min(100.0, 100 * h / p))) if p > 0 else None
    return out


def mean_days(days, years):
    return round(sum(days.get(y, 0) for y in years) / len(years), 1)


def match(settlements, lng, lat):
    near = [(sid, s) for sid, s in settlements.items() if km(s["lng"], s["lat"], lng, lat) <= MATCH_KM]
    return max(near, key=lambda t: t[1]["pop"]) if near else (None, None)


def city_rows(exp30, exp32, trend30, centre=CENTRE):
    big = [mean_days(s["days"], LATE) for s in exp30.values() if s["pop"] >= BIG]
    out = {}
    for region, (lng, lat) in centre.items():
        sid, s = match(exp30, lng, lat)
        sid32, s32 = match(exp32, lng, lat)
        d30 = s["days"] if s else {}
        d32 = s32["days"] if s32 else {}
        late = mean_days(d30, LATE)
        out[region] = {"wh30_early": mean_days(d30, EARLY), "wh30_late": late, "wh32_early": mean_days(d32, EARLY),
                       "wh32_late": mean_days(d32, LATE), "wh30_india_pctile": below_share(late, big)}
        if sid and trend30.get(sid) is not None:
            out[region]["wh_heat_share"] = trend30[sid]
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    d = lambda k, label: FieldSpec(k, label, agg="max", unit="days/yr", ramp="heat", higher_is="worse")
    specs = [
        d("wh30_early", "Days above WBGTmax 30 °C (heavy outdoor work unsafe), 1983-1992"),
        d("wh30_late", "Days above WBGTmax 30 °C (heavy outdoor work unsafe), 2007-2016"),
        d("wh32_early", "Days above WBGTmax 32 °C (light outdoor work unsafe), 1983-1992"),
        d("wh32_late", "Days above WBGTmax 32 °C (light outdoor work unsafe), 2007-2016"),
        FieldSpec("wh_heat_share", "Share of the rise in exposure due to warming, not population", agg="max", unit="%", domain=[0, 100], ramp="heat"),
        FieldSpec("wh30_india_pctile", "Indian 1M+ settlements with fewer days above 30 °C, 2007-2016", agg="max", unit="%", domain=[0, 100], ramp="heat", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="work_heat", title="Days too hot for safe outdoor work (SEDAC UHE-Daily, 1983-2016)", level=LEVEL, fields=specs,
        group="Environment",
        description="Days a year when the maximum Wet Bulb Globe Temperature passed the ISO occupational limits of 30 °C and "
                    "32 °C over the city's urban settlement (CHIRTS-daily, ~5 km), 1983-1992 against 2007-2016, and the share of "
                    "the rise in person-days due to warming rather than population growth, from NASA SEDAC UHE-Daily. One value per city.",
        source="pipeline/realestate/workheat.py (NASA SEDAC sdei-high-res-daily-uhe-1983-2016 wbgtmax30/32 EXP and TREND_ALL tables)",
        license="CC BY 4.0 (Tuholske et al. 2021; CIESIN, NASA SEDAC, doi:10.7927/fq7g-ny13)",
        default_field="wh30_late", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", required=True, help="folder holding wbgtmax30-tabular/ and wbgtmax32-tabular/")
    a = ap.parse_args(argv)
    root = Path(a.dir)
    exp30 = read_exp(root / "wbgtmax30-tabular" / "wbgtmax30_EXP.csv")
    exp32 = read_exp(root / "wbgtmax32-tabular" / "wbgtmax32_EXP.csv")
    trend30 = read_trend(root / "wbgtmax30-tabular" / "wbgtmax30_TREND_ALL.csv")
    for region, f in city_rows(exp30, exp32, trend30).items():
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
