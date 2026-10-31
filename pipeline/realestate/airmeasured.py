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

Delhi, Mumbai, Pune, Hyderabad and Kolkata: the 15-minute readings that CPCB and the state boards publish for each
continuous station (OpenCity's 2024-25 files), averaged by month over calendar 2024 (a month needs 10 days of
readings) and then over the months, at 99 stations placed as described at ``SITES``.

Station sites are from KSPCB's continuous-station map on OpenCity (2023), matched by name; Nisarga Bhavan, whose map
point is misplaced, is placed at the KSPCB office in Saneguruvanahalli and R.V. College, Kengeri, which is not on the
map, at the college.

    python -m pipeline.realestate.airmeasured --region bengaluru,chennai,delhi,mumbai,pune,hyderabad,kolkata
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
HOURLY_PACKAGE = "{}-hourly-air-quality-reports"
HOURLY_YEAR = "2024"
MIN_READINGS = 960     # 15-minute readings a month needs (10 days) to count
# CPCB/SPCB continuous stations with 15-minute files for 2024-25 on OpenCity: (file name before " 15 minute", lat, lng).
# Hyderabad sites are TSPCB's station list (2023); elsewhere the station's locality or landmark in OpenStreetMap
# (Nominatim), checked by hand and corrected where it landed on the wrong place; ~1 km accuracy.
SITES = {
    "pune": [
        ("Alandi IITM", 18.6772, 73.8981), ("Bhosari IITM", 18.621, 73.8501), ("Bhumkar Nagar IITM", 18.603, 73.7494),
        ("Hadapsar IITM", 18.5008, 73.9379), ("Karve Road MPCB", 18.4838, 73.81), ("Katraj Dairy MPCB", 18.4538, 73.857),
        ("Panchawati_Pashan IITM", 18.5306, 73.8123), ("Revenue Colony Shivajinagar", 18.5296, 73.8491), ("Savitribai Phule Pune University MPCB", 18.5528, 73.8266),
        ("Transport Nagar Nigdi", 18.6639, 73.7677),
    ],
    "hyderabad": [
        ("Bollaram Industrial Area TSPCB", 17.5409, 78.3585), ("Central University TSPCB", 17.4601, 78.3344), ("ECIL Kapra TSPCB", 17.4704, 78.5669),
        ("ICRISAT Patancheru TSPCB", 17.5144, 78.2746), ("IDA Pashamylaram TSPCB", 17.5275, 78.1768), ("IITH Kandi TSPCB", 17.5857, 78.1262),
        ("Kokapet TSPCB", 17.3936, 78.3392), ("Kompally Municipal Office TSPCB", 17.5449, 78.487), ("Nacharam_TSIIC IALA TSPCB", 17.4293, 78.5693),
        ("New Malakpet TSPCB", 17.3721, 78.5087), ("Ramachandrapuram TSPCB", 17.5286, 78.2862), ("Sanathnagar TSPCB", 17.4571, 78.4435),
        ("Somajiguda TSPCB", 17.4171, 78.4575), ("Zoo Park TSPCB", 17.3497, 78.4514),
    ],
    "mumbai": [
        ("Bandra Kurla Complex IITM", 19.0593, 72.8613), ("Bandra Kurla Complex MPCB", 19.0593, 72.8613), ("Bandra MPCB", 19.055, 72.8402),
        ("Borivali East IITM", 19.2187, 72.8655), ("Borivali East MPCB", 19.2187, 72.8655), ("Byculla BMC", 18.9766, 72.8328),
        ("Chakala Andheri East", 19.1112, 72.8661), ("Chembur MPCB", 19.0548, 72.898), ("Chhatrapati Shivaji Intl. Airport (T2) MPCB", 19.1023, 72.8745),
        ("Colaba MPCB", 18.9151, 72.826), ("Deonar IITM", 19.0476, 72.9052), ("Ghatkopar BMC", 19.0857, 72.9084),
        ("Kandivali East MPCB", 19.2052, 72.8626), ("Kandivali West BMC", 19.214, 72.8373), ("Kherwadi_Bandra East MPCB", 19.0626, 72.8478),
        ("Khindipada Bhandup West", 19.1606, 72.929), ("Kurla MPCB", 19.0653, 72.8794), ("Malad West IITM", 19.1853, 72.8359),
        ("Mazgaon IITM", 18.9697, 72.8406), ("Mindspace Malad West", 19.1848, 72.8341), ("Mulund West MPCB", 19.172, 72.9512),
        ("Navy Nagar Colaba", 18.9074, 72.8083), ("Powai MPCB", 19.1187, 72.9073), ("Sewri BMC", 18.999, 72.8607),
        ("Shivaji Nagar BMC", 19.0638, 72.9249), ("Siddharth Nagar Worli", 19.0005, 72.815), ("Sion MPCB", 19.0465, 72.8633),
        ("Vile Parle West MPCB", 19.1039, 72.8403), ("Worli MPCB", 18.9988, 72.817),
    ],
    "delhi": [
        ("Alipur DPCC", 28.7973, 77.1387), ("Anand Vihar DPCC", 28.6466, 77.3155), ("Ashok Vihar DPCC", 28.6885, 77.1739),
        ("Aya Nagar IMD", 28.4765, 77.1329), ("Bawana DPCC", 28.7997, 77.0329), ("Burari Crossing IMD", 28.7286, 77.1993),
        ("Chandni Chowk IITM", 28.656, 77.2322), ("CRRI Mathura Road IMD", 28.5501, 77.2752), ("Dr. Karni Singh Shooting Range DPCC", 28.5001, 77.2675),
        ("DTU CPCB", 28.7508, 77.1163), ("Dwarka Sector 8", 28.5656, 77.067), ("IGI Airport (T3) IMD", 28.5562, 77.0924),
        ("IHBAS CPCB", 28.6812, 77.3025), ("ITO CPCB", 28.6282, 77.241), ("Jahangirpuri DPCC", 28.726, 77.1627),
        ("Jawaharlal Nehru Stadium DPCC", 28.5834, 77.2335), ("Lodhi Road IITM", 28.5903, 77.2217), ("Lodhi Road IMD", 28.5903, 77.2217),
        ("Major Dhyan Chand National Stadium DPCC", 28.6126, 77.2373), ("Mandir Marg DPCC", 28.6364, 77.2011), ("Mundka DPCC", 28.6824, 77.0306),
        ("Najafgarh DPCC", 28.6124, 76.9865), ("Narela DPCC", 28.8465, 77.0857), ("Nehru Nagar DPCC", 28.5685, 77.2514),
        ("North Campus IMD", 28.6891, 77.2135), ("NSIT Dwarka CPCB", 28.609, 77.0326), ("Okhla Phase 2", 28.5375, 77.2779),
        ("Patparganj DPCC", 28.6116, 77.2906), ("Punjabi Bagh DPCC", 28.673, 77.1461), ("Pusa DPCC", 28.6363, 77.1576),
        ("Pusa IMD", 28.6363, 77.1576), ("R K Puram DPCC", 28.5504, 77.1855), ("Rohini DPCC", 28.7063, 77.1088),
        ("Shadipur CPCB", 28.6516, 77.1583), ("Sirifort CPCB", 28.5502, 77.2249), ("Sonia Vihar DPCC", 28.7199, 77.2482),
        ("Sri Aurobindo Marg DPCC", 28.5396, 77.2), ("Vivek Vihar DPCC", 28.6692, 77.3123), ("Wazirpur DPCC", 28.6801, 77.1702),
    ],
    "kolkata": [
        ("Ballygunge WBPCB", 22.528, 88.3659), ("Bidhannagar WBPCB", 22.585, 88.4105), ("Fort William WBPCB", 22.5545, 88.338),
        ("Jadavpur WBPCB", 22.4955, 88.3709), ("Rabindra Bharati University WBPCB", 22.627, 88.3805), ("Rabindra Sarobar WBPCB", 22.5123, 88.3636),
        ("Victoria WBPCB", 22.5498, 88.3391),
    ],
}
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


def quarter_hour_months(lines, year=HOURLY_YEAR):
    """{month "01".."12": {"pm10", "pm25", "no2"}} for one station from its 15-minute CSV lines (months with too few
    readings left out)."""
    import csv
    acc = {}
    rd = csv.reader(lines)
    head = next(rd, None) or []
    col = {p: next((i for i, h in enumerate(head) if h.startswith(name + " (")), None) for p, name in (("pm10", "PM10"), ("pm25", "PM2.5"), ("no2", "NO2"))}
    ts = next((i for i, h in enumerate(head) if h == "Timestamp"), 4)
    for r in rd:
        if len(r) <= ts or not r[ts].startswith(year):
            continue
        m = r[ts][5:7]
        for p, i in col.items():
            if i is None or i >= len(r):
                continue
            try:
                v = float(r[i])
            except ValueError:
                continue
            if v > 0:
                a = acc.setdefault(m, {}).setdefault(p, [0.0, 0])
                a[0] += v
                a[1] += 1
    out = {m: {p: a[0] / a[1] for p, a in d.items() if a[1] >= MIN_READINGS} for m, d in sorted(acc.items())}
    return {m: d for m, d in out.items() if d}


def by_month(per_station):
    """[month_averages-shaped dict per month] from {station index: quarter_hour_months result}."""
    months = sorted({m for d in per_station.values() for m in d})
    return [{k: d[m] for k, d in per_station.items() if d.get(m)} for m in months]


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
    ap.add_argument("--region", default="bengaluru,chennai,delhi,mumbai,pune,hyderabad,kolkata")
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
        elif region in SITES:
            stations = SITES[region]
            res = {r["name"].split(" 15 minute")[0]: r["url"] for r in show(HOURLY_PACKAGE.format(region)) if "15 minute" in r["name"]}
            per = {}
            for k, (name, _, _) in enumerate(stations):
                with requests.get(res[name], timeout=600, stream=True) as resp:
                    per[k] = quarter_hour_months(x.decode("utf-8-sig") for x in resp.iter_lines())
            months = by_month(per)
            span = f"{len(stations)} CPCB/SPCB continuous stations, {len(months)} months of {HOURLY_YEAR}"
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
