"""City road deaths 2023-2024 by road user and cause (MoRTH Road Accidents in India 2024 via OpenCity, public domain).

MoRTH's yearly report tables 50 large cities (police city areas): crashes, deaths and injuries for 2023 and 2024
with each city's rank, deaths by road user, and deaths by the traffic violation the police recorded. Each city's L5
blocks carry its figures (dataset ``city_road_deaths``, one value per city):

    rd_killed_2024 / rd_killed_2023 / rd_crashes_2024 / rd_injured_2024 / rd_rank_killed_2024 (1 = most deaths)
    rd_per100      deaths per 100 crashes in 2024 (how severe crashes are); rd_per100_median the 50-city median
    rd_<user>_pct  share of 2024 deaths: pedestrian, cycle, twowheeler, auto, car, truck, bus, other
    rd_<cause>_pct share of 2024 deaths by recorded violation: speeding, drunk, wrongside, redlight, phone

Guna is not among the 50 cities. Figures are the police city's, not the map box's.

    python -m pipeline.realestate.roaddeaths --region all
"""
from __future__ import annotations

import argparse
import csv
import io
import statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 5
BASE = "https://data.opencity.in/dataset/33d29ab0-f9e8-4fc7-b404-c93c1ed8e1b8/resource/"
CITIES_CSV = BASE + "ac75369a-d065-463a-941e-702c6943e796/download/road-accidents-2024-cities-accidents-fatalities.csv"
MODE_CSV = BASE + "3cfe0b01-a4dd-4928-963a-d17e3f5d528d/download/road-accidents-2024-cities-fatalities-mode.csv"
VIOL_CSV = BASE + "39ffbadc-aebd-4e54-8f00-1e5ae00acff6/download/road-accidents-2024-cities-fatalities-traffic-violation.csv"
CITY = {"ahmedabad": "Ahmedabad", "bengaluru": "Bengaluru", "bhopal": "Bhopal", "chennai": "Chennai", "delhi": "Delhi",
        "hyderabad": "Hyderabad", "indore_pilot": "Indore", "jaipur": "Jaipur", "kolkata": "Kolkata", "lucknow": "Lucknow",
        "mumbai": "Mumbai", "pune": "Pune"}
USERS = {"pedestrian": "Pedestrians", "cycle": "Bicycles", "twowheeler": "Two-Wheelers", "auto": "Auto Rickshaws",
         "car": "Cars Taxis, vans and LMVs", "truck": "Trucks lorries", "bus": "Buses",
         "other": ("Other NMT (incl e-rickshaws)", "Others")}
CAUSES = {"speeding": "Over-speeding", "drunk": "Drunk Driving", "wrongside": "Wrong Side", "redlight": "Jumping Red Light",
          "phone": "Mobile Phone"}


def _n(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def _rows(text):
    return {(r.get("City") or "").strip(): r for r in csv.DictReader(io.StringIO(text)) if (r.get("City") or "").strip()}


def figures(cities, modes, viols):
    """{city: {field: value}} from the three city tables (rows keyed by city name), plus the 50-city median severity."""
    out = {}
    for city, r in cities.items():
        if city.lower() == "total":
            continue
        k24, k23, c24 = _n(r.get("2024 Killed")), _n(r.get("2023 Killed")), _n(r.get("2024 Accidents"))
        if k24 is None:
            continue
        f = {"rd_killed_2024": k24, "rd_killed_2023": k23, "rd_crashes_2024": c24, "rd_injured_2024": _n(r.get("2024 Injured")),
             "rd_rank_killed_2024": _n(r.get("2024 Ranking Killed")), "rd_per100": round(100 * k24 / c24, 1) if c24 else None}
        m = modes.get(city)
        if m:
            tot = sum(_n(m.get(c)) or 0 for c in m if c not in ("Sl No", "City"))
            for k, cols in USERS.items():
                cols = cols if isinstance(cols, tuple) else (cols,)
                if tot:
                    f[f"rd_{k}_pct"] = round(100 * sum(_n(m.get(c)) or 0 for c in cols) / tot, 1)
        v = viols.get(city)
        if v and _n(v.get("Total")):
            for k, col in CAUSES.items():
                f[f"rd_{k}_pct"] = round(100 * (_n(v.get(col)) or 0) / _n(v.get("Total")), 1)
        out[city] = {a: b for a, b in f.items() if b is not None}
    med = statistics.median(x["rd_per100"] for x in out.values() if "rd_per100" in x)
    for x in out.values():
        x["rd_per100_median"] = round(med, 1)
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    specs = [
        FieldSpec("rd_killed_2024", "Road deaths in the police city, 2024", agg="max", unit="deaths", ramp="reds", higher_is="worse"),
        FieldSpec("rd_killed_2023", "Road deaths in the police city, 2023", agg="max", unit="deaths", ramp="reds", higher_is="worse"),
        FieldSpec("rd_crashes_2024", "Road crashes in the police city, 2024", agg="max", unit="crashes", ramp="reds", higher_is="worse"),
        FieldSpec("rd_injured_2024", "People injured on the roads, 2024", agg="max", unit="people", ramp="reds", higher_is="worse"),
        FieldSpec("rd_rank_killed_2024", "Rank by road deaths among 50 large cities, 2024 (1 = most)", agg="min", unit="rank", ramp="viridis", higher_is="better"),
        FieldSpec("rd_per100", "Road deaths per 100 crashes, 2024", agg="mean", unit="per 100", ramp="reds", higher_is="worse"),
        FieldSpec("rd_per100_median", "Road deaths per 100 crashes, median of 50 large cities", agg="mean", unit="per 100", ramp="reds", higher_is="worse"),
    ]
    specs += [FieldSpec(f"rd_{k}_pct", f"Share of 2024 road deaths: {k.replace('twowheeler', 'two-wheeler')} users", agg="mean", unit="%", domain=[0, 60], ramp="reds", higher_is=None) for k in USERS]
    specs += [FieldSpec(f"rd_{k}_pct", f"Share of 2024 road deaths recorded as {CAUSES[k].lower()}", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is=None) for k in CAUSES]
    spec = DatasetSpec(
        id="city_road_deaths", title="City road deaths (MoRTH 2024)", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Road crashes, deaths and injuries in the police city area for 2023 and 2024, deaths by road user and by the "
                    "violation the police recorded, from the Ministry of Road Transport and Highways' Road Accidents in India "
                    "2024 (via data.opencity.in). One value per city; the police city is not the map box.",
        source="pipeline/realestate/roaddeaths.py (MoRTH Road Accidents in India 2024 city tables via OpenCity)",
        license="Public domain (MoRTH via data.opencity.in)", default_field="rd_per100", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    get = lambda u: _rows(requests.get(u, timeout=120).content.decode("utf-8-sig"))
    fig = figures(get(CITIES_CSV), get(MODE_CSV), get(VIOL_CSV))
    for region in (list(CITY) if a.region == "all" else a.region.split(",")):
        f = fig.get(CITY.get(region, ""))
        if not f:
            print(f"{region}: not among MoRTH's 50 cities")
            continue
        info = cell_dataset(region, f)
        print(f"{region}: {f['rd_killed_2024']:.0f} deaths 2024, {f.get('rd_per100')} per 100 crashes, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
