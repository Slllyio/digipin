"""Measured air quality at the nearest monitoring station: KSPCB and TNPCB station reports (via OpenCity, public domain).

KSPCB publishes a monthly report for its 11 continuous ambient air quality stations (CAAQMS) in Bengaluru with each
station's monthly average of PM10, PM2.5 (9 stations), NO2 and other pollutants. This module reads the latest 12
monthly reports, averages each station's monthly means and gives each lived-in L7 block (dataset ``air_measured``)
its nearest station's figures:

    am_pm25 / am_pm10 / am_no2   12-month average of the station's monthly means (µg/m³); PM2.5 from the nearest
                                 station that measures it
    am_pm10_months_over          months whose PM10 average was above the 60 µg/m³ annual standard
    am_km / am_pm25_km           distance to that station (km)
    am_station                   station number (STATIONS order)
    am_months                    months the averages cover

Chennai: TNPCB's daily readings at its five stations (Kodungaiyur, Koyambedu, Manali, Perungudi, Royapuram) for
January to August 2024, the latest on OpenCity, averaged the same way (monthly means, then their average).

Station sites are from KSPCB's continuous-station map on OpenCity (2023), matched by name; Nisarga Bhavan, whose map
point is misplaced, is placed at the KSPCB office in Saneguruvanahalli and R.V. College, Kengeri, which is not on the
map, at the college.

    python -m pipeline.realestate.airmeasured --region bengaluru,chennai
"""
from __future__ import annotations

import argparse
import math
import re
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "bengaluru-monthly-air-quality-reports"
MONTHS = 12
PM10_STD = 60
# (key in the report's station title, lat, lng)
STATIONS = [
    ("railway station", 12.9781, 77.5697), ("nisarga bhavan", 12.9950, 77.5440), ("hebbal", 13.0354, 77.5988),
    ("jayanagar", 12.9208, 77.5842), ("kavika", 12.9568, 77.5397), ("nimhans", 12.9375, 77.5949),
    ("silkboard", 12.9177, 77.6238), ("kengeri", 12.9232, 77.5007), ("jigani", 12.7816, 77.6299),
    ("kasturinagar", 13.0039, 77.6642), ("peenya", 13.0285, 77.5197),
]
CHENNAI_PACKAGE = "chennai-air-quality-reports-2022-2024"
CHENNAI_STATIONS = [
    ("kodungaiyur", 13.1365, 80.2480), ("koyambedu", 13.0694, 80.1948), ("manali", 13.1646, 80.2622),
    ("perungudi", 12.9532, 80.2357), ("royapuram", 13.1137, 80.2948),
]
TITLE = re.compile(r"^\s*(.+?)\s+[-–]\s+[A-Z][a-z]+\s*[-–]?\s*20\d\d\s*$")


def station_of(title, stations=STATIONS):
    t = title.lower().replace(" ", "")
    return next((k for k, (key, _, _) in enumerate(stations) if key.replace(" ", "") in t), None)


def month_averages(text):
    """{station index: {"pm10", "pm25", "no2"}} from one monthly report's text."""
    out, cur, cols = {}, None, None
    for line in text.splitlines():
        m = TITLE.match(line)
        if m:
            cur, cols = station_of(m.group(1)), None
            continue
        s = line.split()
        if cur is not None and cols is None and "PM10" in s:   # the pollutant row, with or without "Date" in front
            cols = s[1:] if s[0] == "Date" else s
        elif s and s[0] == "Average" and cur is not None and cols:
            vals = {}
            for name, v in zip(cols, s[1:]):
                try:
                    vals[name] = float(v)
                except ValueError:
                    pass
            pick = {"pm10": vals.get("PM10"), "pm25": vals.get("PM2.5"), "no2": vals.get("NO2")}
            out[cur] = {k: v for k, v in pick.items() if v is not None and v > 0}
            cur = None
    return out


def daily_months(rows, stations=CHENNAI_STATIONS):
    """[month_averages-shaped dict per month] from daily rows (Date '01 JANUARY', Station, PM2.5, PM10, NO2)."""
    by = {}
    for r in rows:
        k, month = station_of(r.get("Station") or "", stations), (r.get("Date") or "").upper().split()[-1:]
        if k is None or not month:
            continue
        for p, col in (("pm10", "PM10"), ("pm25", "PM2.5"), ("no2", "NO2")):
            try:
                v = float(r.get(col))
            except (TypeError, ValueError):
                continue
            if v > 0:
                by.setdefault(month[0], {}).setdefault(k, {}).setdefault(p, []).append(v)
    return [{k: {p: sum(v) / len(v) for p, v in d.items()} for k, d in m.items()} for _, m in sorted(by.items())]


def station_means(months, stations=STATIONS):
    """[{pm10, pm25, no2, n, over}] per station from a list of month_averages results."""
    acc = [{"pm10": [], "pm25": [], "no2": []} for _ in stations]
    for m in months:
        for k, v in m.items():
            for p, x in v.items():
                acc[k][p].append(x)
    out = []
    for a in acc:
        r = {p: round(sum(x) / len(x), 1) for p, x in a.items() if x}
        r["n"] = len(a["pm10"])
        r["over"] = sum(1 for x in a["pm10"] if x > PM10_STD)
        out.append(r)
    return out


def block_rows(cells, means, stations=STATIONS):
    kx = 111.32 * math.cos(math.radians(13.0))
    d = lambda la, lo, s: math.hypot((la - s[1]) * 110.57, (lo - s[2]) * kx)
    have = [k for k, m in enumerate(means) if m.get("pm10")]
    have25 = [k for k, m in enumerate(means) if m.get("pm25")]
    rows = {}
    for code, la, lo in cells:
        k = min(have, key=lambda j: d(la, lo, stations[j]))
        j = min(have25, key=lambda j: d(la, lo, stations[j]))
        m = means[k]
        r = {"am_pm10": m["pm10"], "am_pm10_months_over": m["over"], "am_km": round(d(la, lo, stations[k]), 2), "am_station": k + 1,
             "am_pm25": means[j]["pm25"], "am_pm25_km": round(d(la, lo, stations[j]), 2), "am_months": m["n"]}
        if "no2" in m:
            r["am_no2"] = m["no2"]
        rows[code] = r
    return rows


def cell_dataset(region, rows, span):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("am_pm25", "PM2.5 measured at the nearest station, 12-month average", agg="mean", unit="µg/m³", domain=[10, 50], ramp="reds", higher_is="worse"),
        FieldSpec("am_pm10", "PM10 measured at the nearest station, 12-month average", agg="mean", unit="µg/m³", domain=[30, 120], ramp="reds", higher_is="worse"),
        FieldSpec("am_no2", "NO2 measured at the nearest station, 12-month average", agg="mean", unit="µg/m³", domain=[0, 40], ramp="reds", higher_is="worse"),
        FieldSpec("am_pm10_months_over", "Months the nearest station's PM10 average was above the annual standard", agg="mean", unit="months", domain=[0, 12], ramp="reds", higher_is="worse"),
        FieldSpec("am_km", "Distance to the nearest continuous air quality station", agg="mean", unit="km", domain=[0, 15], ramp="viridis", higher_is=None),
        FieldSpec("am_pm25_km", "Distance to the nearest station measuring PM2.5", agg="mean", unit="km", domain=[0, 15], ramp="viridis", higher_is=None),
        FieldSpec("am_station", "Nearest continuous station (number)", agg="mode", ramp="viridis", higher_is=None),
        FieldSpec("am_months", "Months the station averages cover", agg="max", unit="months", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="air_measured", title="Measured air quality at the nearest station (state pollution boards)", level=LEVEL, fields=specs, group="Environment",
        description=f"Average PM2.5, PM10 and NO2 at the nearest state pollution control board station ({span}), from the "
                    f"station reports on data.opencity.in (KSPCB's 11 continuous stations in Bengaluru, TNPCB's five in "
                    f"Chennai). Ground measurements at one point; blocks far from a station inherit its value.",
        source="pipeline/realestate/airmeasured.py (KSPCB monthly CAAQMS reports and TNPCB daily readings via OpenCity)",
        license="Public domain (KSPCB, TNPCB via data.opencity.in)", default_field="am_pm25", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def pdf_text(url):
    import requests
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(requests.get(url, timeout=180).content)
        f.flush()
        return subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, check=True).stdout


def main(argv=None):
    import csv
    import io
    import requests
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru,chennai")
    show = lambda pkg: requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": pkg}, timeout=60).json()["result"]["resources"]
    for region in ap.parse_args(argv).region.split(","):
        if region == "bengaluru":
            res = [r for r in show(PACKAGE) if r["name"].startswith("Air Quality Report")][-MONTHS:]
            stations, months = STATIONS, [month_averages(pdf_text(r["url"])) for r in res]
            span = f"KSPCB, {res[0]['name'].split('Report ')[-1]} to {res[-1]['name'].split('Report ')[-1]}"
        elif region == "chennai":
            res = next(r for r in show(CHENNAI_PACKAGE) if r["name"].endswith("2024"))
            rows = list(csv.DictReader(io.StringIO(requests.get(res["url"], timeout=120).content.decode("utf-8-sig"))))
            stations, months = CHENNAI_STATIONS, daily_months(rows)
            span = f"TNPCB, {len(months)} months of 2024"
        else:
            print(f"{region}: no station reports")
            continue
        means = station_means(months, stations)
        for k, m in enumerate(means):
            print(" ", stations[k][0], m)
        rows = block_rows(lived_cells(region), means, stations)
        cell_dataset(region, rows, span)
        print(f"{region}: {span}, {len(rows)} blocks")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
