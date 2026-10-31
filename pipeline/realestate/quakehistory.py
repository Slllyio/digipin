"""Past earthquakes felt near each block, from the USGS ComCat earthquake catalogue (public domain, US Government work).

India's seismic zone map (BIS IS 1893) is not openly licensed, so this shows the record instead: instrumental and
historical events of magnitude 4.5 or more since 1900 within ``RADIUS_KM`` of each lived-in L7 block (dataset
``quake_history``):

    qh_n45          events M4.5+ within RADIUS_KM since 1900
    qh_n6           events M6+ within RADIUS_KM since 1900
    qh_max_mag      the largest magnitude within RADIUS_KM
    qh_max_year     the year of that largest event
    qh_near_m5_km   distance to the nearest M5+ epicentre since 1900 (km)

The catalogue is incomplete before about 1964 (the global seismograph network) and for small events, so counts are a floor.

    python -m pipeline.realestate.quakehistory --region delhi
"""
from __future__ import annotations

import argparse
import json
import math
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from pipeline._lib.regions import bbox_for

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RADIUS_KM = 300.0
URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"


def km(lat1, lng1, lat2, lng2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2
    return 12742.0 * math.asin(math.sqrt(a))


def parse(geojson):
    """USGS GeoJSON -> [(lat, lng, mag, year)]."""
    out = []
    for f in geojson.get("features", []):
        m = f["properties"].get("mag")
        if m is None:
            continue
        lng, lat = f["geometry"]["coordinates"][:2]
        yr = datetime.fromtimestamp(f["properties"]["time"] / 1000, tz=timezone.utc).year
        out.append((lat, lng, float(m), yr))
    return out


def rows_from(cells, quakes, radius=RADIUS_KM):
    """cells [(code, lat, lng)], quakes [(lat, lng, mag, year)] -> {code: fields}."""
    out = {}
    for code, la, ln in cells:
        n45 = n6 = 0
        best = None
        near5 = None
        for qa, qn, m, yr in quakes:
            d = km(la, ln, qa, qn)
            if m >= 5 and (near5 is None or d < near5):
                near5 = d
            if d > radius or m < 4.5:
                continue
            n45 += 1
            n6 += m >= 6
            if best is None or m > best[0]:
                best = (m, yr)
        r = {"qh_n45": n45, "qh_n6": n6}
        if best:
            r["qh_max_mag"], r["qh_max_year"] = round(best[0], 1), best[1]
        if near5 is not None:
            r["qh_near_m5_km"] = round(near5, 1)
        out[code] = r
    return out


def fetch(region):
    from pipeline.realestate.powerplants import lived_cells
    w, s, e, n = bbox_for(region)
    lat, lng = (s + n) / 2, (w + e) / 2
    q = f"{URL}?format=geojson&starttime=1900-01-01&latitude={lat}&longitude={lng}&maxradiuskm=900&minmagnitude=4.5"
    with urllib.request.urlopen(q, timeout=120) as r:
        quakes = parse(json.load(r))
    return rows_from(lived_cells(region), quakes), quakes


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("qh_n45", f"Earthquakes M4.5+ within {RADIUS_KM:.0f} km since 1900", agg="mean", unit="events", ramp="reds", higher_is="worse"),
        FieldSpec("qh_n6", f"Earthquakes M6+ within {RADIUS_KM:.0f} km since 1900", agg="mean", unit="events", ramp="reds", higher_is="worse"),
        FieldSpec("qh_max_mag", f"Largest earthquake within {RADIUS_KM:.0f} km since 1900", agg="max", unit="magnitude", domain=[4.5, 8.5], ramp="reds", higher_is="worse"),
        FieldSpec("qh_max_year", "Year of that largest earthquake", agg="max", unit="year"),
        FieldSpec("qh_near_m5_km", "Distance to the nearest M5+ epicentre since 1900", agg="mean", unit="km", ramp="reds", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="quake_history", title="Past earthquakes near each block (USGS ComCat, since 1900)", level=LEVEL, fields=specs,
        group="Hazards",
        description=f"Earthquakes of magnitude 4.5 or more since 1900 within {RADIUS_KM:.0f} km of each lived-in block, from the USGS "
                    "ComCat catalogue. Incomplete before about 1964, so a floor; this is the record, not the BIS seismic zone.",
        source="pipeline/realestate/quakehistory.py (USGS FDSN event service)",
        license="Public domain (USGS, US Government work)", default_field="qh_max_mag", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        rows, quakes = fetch(region)
        info = cell_dataset(region, rows)
        v = list(rows.values())
        mx = max(v, key=lambda r: r.get("qh_max_mag", 0))
        print(f"{region}: {len(quakes)} quakes in 900 km; blocks {len(v)}; n45 {min(r['qh_n45'] for r in v)}-{max(r['qh_n45'] for r in v)}; "
              f"max M{mx.get('qh_max_mag')} ({mx.get('qh_max_year')}); nearest M5 {min(r.get('qh_near_m5_km', 9e9) for r in v):.0f} km; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
