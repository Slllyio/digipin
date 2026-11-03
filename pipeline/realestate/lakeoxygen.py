"""Oxygen and sewage in Hyderabad's lakes: CPCB's National Water Quality Monitoring Programme 2021 (via OpenCity, public domain).

CPCB's NWMP table for lakes, ponds, tanks and wetlands gives each monitored water body's minimum and maximum dissolved
oxygen, BOD, nitrate, faecal and total coliform over the year's samples. Telangana's board samples about 90 lakes in
and around Hyderabad; 30 of them could be placed with confidence. The table gives no coordinates, so each lake is placed at its OpenStreetMap location
(``LAKES``, matched by name with Overture and Nominatim and checked by hand); lakes that could not be placed are left
out. Per lived-in L7 block in Hyderabad (dataset ``lake_oxygen``), from the nearest placed lake within 2 km:

    lo_do_min / lo_do_max   lowest and highest dissolved oxygen sampled in 2021 (mg/L; fish need 4 or more)
    lo_bod_max              highest BOD (mg/L)
    lo_fc_max               highest faecal coliform (MPN/100 ml)
    lo_km                   distance to that lake
    lo_lakes_2km            placed lakes within 2 km
    lo_dead_2km             of them, lakes whose oxygen never reached 4 mg/L in any 2021 sample

    python -m pipeline.realestate.lakeoxygen
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NEAR_KM = 2.0
FISH_DO = 4.0
URL = ("https://data.opencity.in/dataset/b315fb5d-4625-457b-86e4-5fec7f7831ea/resource/60886be0-840a-44da-8c83-9823b193c8b6/"
       "download/4e742cc5-01ee-4851-ad32-8ce486bf552b.pdf")
ROW = re.compile(r"^\s*(\d{4})\s{2,}(.*?)\s*\b(LAKE|POND|TANK|Wetland|WETLAND|Lake|Pond|Tank|RESERVOIR|Reservoir)\s+([A-Z][A-Z &]+?)\s{2,}(.*)$")
# NWMP station code -> (lat, lng) of the lake in OpenStreetMap; names that match several lakes (Patel, Pedda, Kotha
# Cheruvu) are placed only where the locality in the name confirms which
LAKES = {
    "1391": (17.4229, 78.4754), "1788": (17.3549, 78.5272), "1789": (17.3129, 78.3535), "2340": (17.4246, 78.698),
    "2341": (17.3453, 78.439), "2342": (17.3156, 78.4274), "2344": (17.4882, 78.4184), "2357": (17.4311, 78.3897),
    "3069": (17.6094, 78.5587), "3070": (17.5259, 78.4691), "3071": (17.3803, 78.4157), "3072": (17.4634, 78.5363),
    "3074": (17.4108, 78.4485), "3076": (17.5118, 78.3933), "3077": (17.495, 78.5534), "4234": (17.2919, 78.4563),
    "4236": (17.421, 78.5541), "4237": (17.4675, 78.3881), "4238": (17.5231, 78.3332), "4672": (17.4249, 78.3419),
    "4675": (17.4138, 78.4203), "4676": (17.4612, 78.5464), "4689": (17.4521, 78.4034), "4702": (17.4248, 78.3728),
    "4704": (17.3459, 78.5622), "4705": (17.5079, 78.5115), "5038": (17.3104, 78.473), "5042": (17.5014, 78.407),
    "5057": (17.467, 78.3461), "5059": (17.4794, 78.3281),
}


def _f(x):
    try:
        return float(x)
    except ValueError:
        return None


def lakes(text, state="TELANGANA"):
    """{code: {do_min, do_max, bod_max, fc_max}} for one state's rows (16 numbers: min/max of temperature, DO, pH,
    conductivity, BOD, nitrate, faecal and total coliform)."""
    out = {}
    for line in text.splitlines():
        m = ROW.match(line)
        if not m or m.group(4).strip() != state:
            continue
        v = [_f(x) for x in m.group(5).split()]
        if len(v) != 16:
            continue
        r = {"do_min": v[2], "do_max": v[3], "bod_max": v[9], "fc_max": v[13]}
        out[m.group(1)] = {k: x for k, x in r.items() if x is not None}
    return out


def block_rows(cells, table, sites=None):
    sites = LAKES if sites is None else sites
    pts = [(c, *sites[c]) for c in table if c in sites and "do_max" in table[c]]
    kx = 111.32 * math.cos(math.radians(17.4))
    rows = {}
    for code, la, lo in cells:
        near = sorted((math.hypot((la - p[1]) * 110.57, (lo - p[2]) * kx), p[0]) for p in pts)
        near = [(km, c) for km, c in near if km <= NEAR_KM]
        if not near:
            continue
        km, c = near[0]
        r = {f"lo_{k}": v for k, v in table[c].items()}
        r.update(lo_km=round(km, 2), lo_lakes_2km=len(near), lo_dead_2km=sum(1 for _, x in near if table[x]["do_max"] < FISH_DO))
        rows[code] = r
    return rows


def cell_dataset(region, rows, n_lakes):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("lo_do_max", "Highest dissolved oxygen at the nearest sampled lake, 2021", agg="mean", unit="mg/L", domain=[0, 8], ramp="viridis", higher_is="better"),
        FieldSpec("lo_do_min", "Lowest dissolved oxygen at the nearest sampled lake, 2021", agg="mean", unit="mg/L", domain=[0, 6], ramp="viridis", higher_is="better"),
        FieldSpec("lo_bod_max", "Highest BOD at the nearest sampled lake, 2021", agg="mean", unit="mg/L", domain=[0, 30], ramp="reds", higher_is="worse"),
        FieldSpec("lo_fc_max", "Highest faecal coliform at the nearest sampled lake, 2021", agg="mean", unit="MPN/100 ml", ramp="reds", higher_is="worse"),
        FieldSpec("lo_km", "Distance to the nearest sampled lake", agg="mean", unit="km", domain=[0, 2], ramp="viridis", higher_is=None),
        FieldSpec("lo_lakes_2km", "Sampled lakes within 2 km", agg="mean", unit="lakes", ramp="viridis", higher_is=None),
        FieldSpec("lo_dead_2km", "Lakes within 2 km whose oxygen never reached 4 mg/L in 2021", agg="mean", unit="lakes", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="lake_oxygen", title="Lake oxygen and sewage (CPCB NWMP 2021)", level=LEVEL, fields=specs, group="Environment",
        description=f"Lowest and highest dissolved oxygen, highest BOD and faecal coliform in 2021 at the nearest of {n_lakes} "
                    f"lakes the Telangana pollution board samples under CPCB's National Water Quality Monitoring Programme, for "
                    f"blocks within 2 km of one (via data.opencity.in). Lakes placed at their OpenStreetMap location.",
        source="pipeline/realestate/lakeoxygen.py (CPCB NWMP 2021 lakes, ponds, tanks and wetlands via OpenCity; lake sites from OpenStreetMap)",
        license="Public domain (CPCB via data.opencity.in); lake sites © OpenStreetMap contributors (ODbL)", default_field="lo_do_max", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def pdf_text(url):
    import requests
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(requests.get(url, timeout=180).content)
        f.flush()
        return subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, check=True).stdout


def main(argv=None):
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="hyderabad")
    region = ap.parse_args(argv).region
    table = lakes(pdf_text(URL))
    rows = block_rows(lived_cells(region), table)
    placed = [c for c in table if c in LAKES]
    cell_dataset(region, rows, len(placed))
    dead = sum(1 for c in placed if table[c].get("do_max", 9) < FISH_DO)
    print(json.dumps({"region": region, "lakes": len(table), "placed": len(placed), "never_4": dead, "blocks": len(rows)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
