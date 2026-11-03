"""Police station jurisdiction per block (OpenCity, public domain).

Dataset ``police_stations`` (L7, lived-in blocks): ``station``, the law-and-order police station whose jurisdiction
holds the block's centre, from the jurisdiction maps for Mumbai (city police, 91 stations), Bengaluru (KSP/KGIS
boundaries, about 120), Hyderabad (city police, 73) and Chennai (Greater Chennai Police, about 220). It answers "which
police station is this?" in DISHA and the property report, and is the join key for station-wise crime tables.
(Station points and the reach lens live in ``police.py``.)

    python -m pipeline.realestate.policejuris --region mumbai,bengaluru,hyderabad,chennai
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
API = "https://data.opencity.in/api/3/action/package_show?id="
PKGS = {"mumbai": "police-jurisdiction-maps-for-major-cities-of-india", "bengaluru": "police-jurisdiction-maps-for-major-cities-of-india",
        "hyderabad": "police-jurisdiction-maps-for-major-cities-of-india", "chennai": "chennai-police-jurisdictions"}
TITLES = {"mumbai": "Mumbai Police Jurisdictions Map", "bengaluru": "Bengaluru Police Jurisdictions Map",
          "hyderabad": "Hyderabad Police Jurisdictions Map", "chennai": "Chennai Police Jurisdictions Map"}


def station_name(props, name):
    """Readable station name: 'Cuffe Parade', 'Kaggalipura', 'Bahadurpura', 'V4 Rajamangalam'."""
    s = (props.get("PS_Name_1") or props.get("PS_BOUNDName") or props.get("police_station_name") or name or "").strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*\b(police station|p\.?\s?s\.?|ps)\s*$", "", s, flags=re.IGNORECASE).strip()
    return s or None


def features(region):
    import requests

    from pipeline.realestate.wards import kml_features
    res = json.loads(requests.get(API + PKGS[region], timeout=120).text)["result"]["resources"]
    url = next(r["url"] for r in res if r["name"].strip() == TITLES[region])
    return kml_features(requests.get(url, timeout=300).content.decode("utf-8-sig"))


def assign(region, feats):
    import duckdb

    from pipeline.realestate.powerplants import lived_cells
    from pipeline.realestate.wards import closed
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
    con.executemany("INSERT INTO w VALUES (?, ST_GeomFromGeoJSON(?))",
                    [(k, json.dumps(g)) for k, g in ((k, closed(f["geometry"])) for k, f in enumerate(feats)) if g])
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", lived_cells(region))
    hits = con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(ST_MakeValid(w.geom), ST_Point(c.x, c.y)) GROUP BY 1").fetchall()
    out = {}
    for code, k in hits:
        s = station_name(feats[k]["properties"], feats[k].get("name"))
        if s:
            out[code] = {"station": s}
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("station", "Police station (law and order)", type="category", agg="mode")]
    spec = DatasetSpec(
        id="police_stations", title="Police station jurisdictions (OpenCity)", level=LEVEL, fields=specs, group="Real estate",
        description="The police station whose jurisdiction holds each lived-in block's centre, from the jurisdiction maps on "
                    "data.opencity.in for Mumbai, Bengaluru, Hyderabad and Chennai. Stations are added and boundaries redrawn from time "
                    "to time, so check the police website for a specific address.",
        source="pipeline/realestate/policejuris.py (OpenCity police jurisdiction maps via DuckDB spatial)",
        license="Public domain (data.opencity.in)", default_field="station", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(TITLES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        feats = features(r)
        rows = assign(r, feats)
        print(f"{r}: {len(feats)} jurisdictions, {len(rows)} blocks, {len({x['station'] for x in rows.values()})} stations")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
