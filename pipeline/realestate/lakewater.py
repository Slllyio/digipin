"""Measured lake water quality near each block, Bengaluru: KSPCB monthly lake reports (via OpenCity, public domain).

KSPCB samples about 140 lakes and tanks in and around Bengaluru every month and publishes each sample's use-based
class (CPCB criteria: A drinking without treatment ... D wildlife and fisheries, E irrigation and industrial cooling
only), dissolved oxygen, BOD and faecal coliform among 40 parameters. This module reads the monthly reports on OpenCity
(those in the text layout, May to November 2025 at the time of writing) and summarises each lake. The reports give
station codes and names but no coordinates, so each lake is placed at its OpenStreetMap location (``LAKES``, matched
by name against Overture's OSM-derived water features and checked by hand); lakes that could not be found are left out.

Per lived-in L7 block in Bengaluru (dataset ``lake_water``), from the nearest monitored lake within 2 km:

    lw_km          distance to that lake
    lw_e_share     share of its monthly samples in class E (unfit even for fish and wildlife), %
    lw_do          mean dissolved oxygen (mg/L; class D needs 4 or more)
    lw_bod         mean BOD (mg/L)
    lw_fc          median faecal coliform (MPN/100 ml)
    lw_lakes_2km   monitored lakes within 2 km;  lw_e_lakes_2km  of them, class E in most samples

    python -m pipeline.realestate.lakewater
"""
from __future__ import annotations

import argparse
import math
import re
import statistics
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "bengaluru-lake-monthly-water-quality-reports"
NEAR_KM = 2.0
ROW = re.compile(r"^\s*(\d{4})\s+([A-Z][a-z]{2,8})\s+(.*?)\s+([A-E])\s+(-?[\d.]+|BDL)\s+(.*)$")
# KSPCB station code -> (lat, lng) of the lake in OpenStreetMap (via Overture base water), matched by name; lakes with
# two candidates of the same name (Puttenahalli, Hosakere, Basavanapura) and repeat stations on one lake are left out
LAKES = {
    "3589": (12.9065, 77.6163), "3590": (12.9461, 77.5834), "3591": (12.9518, 77.5603),
    "3592": (12.9336, 77.5767), "3593": (12.9824, 77.6192), "3594": (13.0096, 77.5742), "3595": (12.9303, 77.5957),
    "3596": (12.94, 77.5215), "3597": (13.1649, 77.4925), "3598": (12.989, 77.4901), "3599": (13.0505, 77.4794),
    "3600": (13.0268, 77.5047), "3602": (12.9348, 77.6638), "3604": (12.9754, 77.688), "3605": (13.0257, 77.7283),
    "3606": (13.0409, 77.5122), "3607": (13.0473, 77.6643), "3608": (12.9472, 77.7363), "3609": (12.9225, 77.6669),
    "3610": (12.9584, 77.7255), "3611": (12.9129, 77.6727), "3612": (12.8507, 77.4909), "3613": (12.8529, 77.5902),
    "3615": (12.8829, 77.5986), "3616": (12.8656, 77.5898), "3617": (12.8704, 77.6042), "3618": (12.8822, 77.6455),
    "3619": (12.874, 77.6305), "3620": (12.8788, 77.6611), "3621": (12.8966, 77.6628), "3622": (12.8986, 77.6481),
    "3625": (13.0471, 77.5863), "3626": (13.045, 77.6077), "3627": (13.0868, 77.6103), "3628": (13.0616, 77.5986),
    "3629": (13.0912, 77.5872), "3630": (13.1135, 77.5935), "3633": (12.8962, 77.5429), "3635": (12.9651, 77.4946),
    "3638": (12.8996, 77.5656), "3639": (12.9166, 77.488), "3643": (12.9969, 77.6658), "3655": (13.0349, 77.5508),
    "4094": (13.018, 77.474), "4095": (13.0826, 77.5075), "4096": (13.0109, 77.4862), "4097": (12.9997, 77.4664),
    "4504": (12.899, 77.5789), "4505": (13.0901, 77.4128), "4506": (13.0795, 77.5286), "4507": (13.0266, 77.6451),
    "4508": (13.0854, 77.5387), "4509": (13.0726, 77.5587), "4510": (13.0627, 77.6138), "4511": (13.1102, 77.619),
    "4515": (13.0245, 77.709), "4516": (12.9697, 77.7205), "4517": (13.0126, 77.6852), "4518": (12.9908, 77.6959),
    "4519": (13.0474, 77.6861), "4520": (12.9658, 77.7071), "4521": (12.9232, 77.6871), "4523": (12.9745, 77.7358),
    "4524": (12.9766, 77.7458), "4525": (12.9822, 77.7131), "4526": (13.0015, 77.7031), "4528": (12.9119, 77.6935),
    "4529": (12.9045, 77.6677), "4530": (12.8268, 77.6869), "4531": (12.8699, 77.6771), "4532": (12.8216, 77.7018),
    "4533": (12.9611, 77.4809), "4534": (12.8701, 77.769), "4535": (12.8807, 77.5408), "4536": (12.9265, 77.5341),
    "4539": (13.043, 77.4956), "4540": (13.0685, 77.5241), "4541": (13.0976, 77.4588), "5567": (12.8821, 77.5617),
    "5569": (12.9785, 77.662), "5833": (13.0765, 77.6733), "5834": (13.0873, 77.665),
    "5835": (13.009, 77.6766), "5836": (13.0437, 77.7406), "5840": (12.9316, 77.7069), "5842": (12.9874, 77.6924),
    "5843": (12.9964, 77.6828), "5844": (12.8988, 77.692),
}


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def samples(text):
    """[(code, class, DO, BOD, faecal coliform)] from one monthly report's text."""
    out = []
    for line in text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        v = m.group(6).split()
        # after temperature: DO, pH, conductivity, BOD, nitrate-N, nitrite-N, faecal coliform, total coliform, ...
        out.append((m.group(1), m.group(4), _f(v[0]) if v else None, _f(v[3]) if len(v) > 3 else None, _f(v[6]) if len(v) > 6 else None))
    return out


def lake_summary(all_samples):
    """{code: {n, e_share, do, bod, fc}} over all months."""
    by = {}
    for code, cls, do, bod, fc in all_samples:
        by.setdefault(code, []).append((cls, do, bod, fc))
    out = {}
    for code, s in by.items():
        mean = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
        r = {"n": len(s), "e_share": round(100 * sum(1 for x in s if x[0] == "E") / len(s)),
             "do": mean([x[1] for x in s if x[1] is not None]), "bod": mean([x[2] for x in s if x[2] is not None])}
        fc = [x[3] for x in s if x[3] is not None]
        if fc:
            r["fc"] = statistics.median(fc)
        out[code] = {k: v for k, v in r.items() if v is not None}
    return out


def block_rows(cells, summary, lakes=None):
    lakes = LAKES if lakes is None else lakes
    sites = [(code, *lakes[code]) for code in summary if code in lakes]
    kx = 111.32 * math.cos(math.radians(13.0))
    rows = {}
    for code, la, lo in cells:
        d = sorted((math.hypot((la - s[1]) * 110.57, (lo - s[2]) * kx), s[0]) for s in sites)
        near = [(km, c) for km, c in d if km <= NEAR_KM]
        if not near:
            continue
        km, c = near[0]
        s = summary[c]
        r = {"lw_km": round(km, 2), "lw_e_share": s["e_share"], "lw_lakes_2km": len(near),
             "lw_e_lakes_2km": sum(1 for _, x in near if summary[x]["e_share"] > 50)}
        for k in ("do", "bod", "fc"):
            if k in s:
                r[f"lw_{k}"] = s[k]
        rows[code] = r
    return rows


def cell_dataset(region, rows, span):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("lw_e_share", "Samples in class E at the nearest monitored lake", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("lw_do", "Dissolved oxygen at the nearest monitored lake", agg="mean", unit="mg/L", domain=[0, 8], ramp="viridis", higher_is="better"),
        FieldSpec("lw_bod", "BOD at the nearest monitored lake", agg="mean", unit="mg/L", domain=[0, 30], ramp="reds", higher_is="worse"),
        FieldSpec("lw_fc", "Faecal coliform at the nearest monitored lake (median)", agg="mean", unit="MPN/100 ml", ramp="reds", higher_is="worse"),
        FieldSpec("lw_km", "Distance to the nearest monitored lake", agg="mean", unit="km", domain=[0, 2], ramp="viridis", higher_is=None),
        FieldSpec("lw_lakes_2km", "Monitored lakes within 2 km", agg="mean", unit="lakes", ramp="viridis", higher_is=None),
        FieldSpec("lw_e_lakes_2km", "Monitored lakes within 2 km in class E most months", agg="mean", unit="lakes", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="lake_water", title="Measured lake water quality (KSPCB monthly lake reports)", level=LEVEL, fields=specs, group="Environment",
        description=f"Use-based class, dissolved oxygen, BOD and faecal coliform at the nearest of the lakes KSPCB samples each "
                    f"month in Bengaluru ({span}), for blocks within 2 km of one, from KSPCB's reports on data.opencity.in. "
                    f"Lakes placed at their OpenStreetMap location.",
        source="pipeline/realestate/lakewater.py (KSPCB monthly lake water quality reports via OpenCity; lake sites from OpenStreetMap)",
        license="Public domain (KSPCB via data.opencity.in); lake sites © OpenStreetMap contributors (ODbL)", default_field="lw_e_share", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def pdf_text(url):
    import requests
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(requests.get(url, timeout=180).content)
        f.flush()
        return subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, check=True).stdout


def main(argv=None):
    import requests
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    region = ap.parse_args(argv).region
    res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PACKAGE}, timeout=60).json()["result"]["resources"]
    used, got = [], []
    for r in res[-14:]:
        s = samples(pdf_text(r["url"]))
        if s:   # scanned months have no text layer
            used.append(r["name"].split("Report ")[-1])
            got += s
    summary = lake_summary(got)
    span = f"{used[0]} to {used[-1]}, {len(used)} months" if used else "no months"
    rows = block_rows(lived_cells(region), summary)
    cell_dataset(region, rows, span)
    placed = sum(1 for c in summary if c in LAKES)
    print(f"{region}: {span}; {len(summary)} lakes sampled, {placed} placed, "
          f"{sum(1 for c in summary if c in LAKES and summary[c]['e_share'] > 50)} placed lakes class E most months; {len(rows)} blocks within 2 km")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
