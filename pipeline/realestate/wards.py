"""Municipal ward per block, from DataMeet's Municipal Spatial Data (corporation ward and zone boundaries).

Per L7 block (dataset ``wards``):

    ward        the municipal ward holding the block centre, as "number name" where the source names it
    ward_no     the ward number (or code)
    zone        the administrative zone or ward group, where the source has one
    body        the urban local body (BBMP, GHMC, MCD ...), so blocks outside the corporation stay blank

Boundaries come from github.com/datameet/Municipal_Spatial_Data (CC BY 4.0), each with its own vintage: several
cities have since redrawn wards (Delhi's MCD went from 272 to 250 wards in 2022; Bengaluru's BBMP was split into
five corporations in 2025), so read the ward as the one on that map, for joining ward-level budgets, complaints and
election data, not as today's legal limit. Indore and Guna have no ward map there.

    python -m pipeline.realestate.wards --region all
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RAW = "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/"


def _num_name(s):
    """'48 RAMOL HATHIJAN' -> ('48', 'Ramol Hathijan'); 'Ward 91 Khairatabad' -> ('91', 'Khairatabad')."""
    m = re.match(r"^\s*(?:ward\s*)?(\d+)\s*[-.:]?\s*(.*)$", str(s or ""), re.IGNORECASE)
    return (m.group(1), m.group(2).strip()) if m else (None, str(s or "").strip())


def _title(s):
    s = str(s or "").strip()
    return s.title() if s.isupper() else s


def _delhi(p):
    """MCD wards are numbered; NDMC and Delhi Cantonment appear as charges ('NDMC_3', 'CANT_2')."""
    no, name = str(p.get("Ward_No") or ""), _title(p.get("Ward_Name"))
    for pre, body in (("NDMC_", "NDMC"), ("CANT_", "Delhi Cantonment Board")):
        if no.startswith(pre):
            return no[len(pre):], f"{body} charge {no[len(pre):]}", None, body
    return no or None, name, None


# city -> (body, file, fn(props) -> (ward_no, name, zone), map year where the source or ward count dates it)
SOURCES = {
    "ahmedabad": ("AMC", "Ahmedabad/Wards.geojson", lambda p: (*map(_title, _num_name(p.get("Name"))), None), "2015"),
    "bengaluru": ("BBMP", "Bangalore/BBMP.geojson", lambda p: (p.get("KGISWardNo"), p.get("KGISWardName"), None), "2022"),
    "bhopal": ("BMC Bhopal", "Bhopal/Bhopal_wards.geojson", lambda p: (p.get("Ward_Number"), p.get("Name"), p.get("zone") and f"Zone {p['zone']}"), None),
    "chennai": ("GCC", "Chennai/Wards.geojson", lambda p: (p.get("Ward_No"), None, p.get("Zone_Name") and _title(p["Zone_Name"])), "2011"),
    "delhi": ("MCD", "Delhi/Delhi_Wards.geojson", lambda p: _delhi(p), "2017"),
    "hyderabad": ("GHMC", "Hyderabad/ghmc-wards.geojson", lambda p: (*_num_name(p.get("name")), None), None),
    "jaipur": ("JMC", "Jaipur/Jaipur_Wards.geojson", lambda p: (p.get("WARD_NO"), None, p.get("ZONE_NAME") and _title(p["ZONE_NAME"])), None),
    "kolkata": ("KMC", "Kolkata/kolkata.geojson", lambda p: (p.get("WARD"), None, None), None),
    "lucknow": ("LMC", "Lucknow/Lucknow_ward_boundary.geojson", lambda p: (p.get("Ward Num"), p.get("Ward Name"), p.get("Zone") and f"Zone {p['Zone']}"), None),
    "mumbai": ("BMC", "Mumbai/BMC_Wards.geojson", lambda p: (p.get("name"), None, None), None),
    "pune": ("PMC", "Pune/pune-electoral-wards_2022.geojson", lambda p: (p.get("wardnum"), p.get("Name2"), None), "2022"),
}


def label(no, name):
    no = None if no in (None, "") else str(no)
    if no and name:
        return f"{no} {name}"
    return no or (name or None)


def closed(geom):
    """Close unclosed rings and drop degenerate ones (some ward files have them)."""
    def ring(r):
        r = [p[:2] for p in r]
        if r and r[0] != r[-1]:
            r = r + [r[0]]
        return r if len(r) >= 4 else None

    def poly(rings):
        out = [x for x in (ring(r) for r in rings) if x]
        return out or None
    if geom["type"] == "Polygon":
        c = poly(geom["coordinates"])
        return {"type": "Polygon", "coordinates": c} if c else None
    if geom["type"] == "MultiPolygon":
        c = [x for x in (poly(p) for p in geom["coordinates"]) if x]
        return {"type": "MultiPolygon", "coordinates": c} if c else None
    return None


def lived_cells(region):
    from pipeline.realestate.powerplants import lived_cells as lc
    return lc(region)


def fetch(region):
    """{code: row} for the lived-in blocks of a region inside a mapped ward."""
    import duckdb
    import requests
    body, path, fn, _ = SOURCES[region]
    r = requests.get(RAW + path, timeout=180)
    r.raise_for_status()
    feats = json.loads(r.content.decode("utf-8-sig"))["features"]
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
    con.executemany("INSERT INTO w VALUES (?, ST_GeomFromGeoJSON(?))",
                    [(k, json.dumps(g)) for k, g in ((k, closed(f["geometry"])) for k, f in enumerate(feats) if f.get("geometry")) if g])
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", lived_cells(region))
    hits = con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(ST_MakeValid(w.geom), ST_Point(c.x, c.y)) GROUP BY 1").fetchall()
    rows = {}
    for code, k in hits:
        no, name, zone, *own = fn(feats[k]["properties"])
        row = {"ward": label(None if own else no, name), "ward_no": None if no in (None, "") else str(no), "zone": zone,
               "body": own[0] if own else body}
        rows[code] = {a: b for a, b in row.items() if b}
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("ward", "Municipal ward", type="category", agg="mode"),
        FieldSpec("ward_no", "Ward number", type="category", agg="mode"),
        FieldSpec("zone", "Municipal zone", type="category", agg="mode"),
        FieldSpec("body", "Municipal corporation", type="category", agg="mode"),
    ]
    vint = SOURCES[region][3]
    spec = DatasetSpec(
        id="wards", title="Municipal wards (DataMeet)", level=LEVEL, fields=specs, group="Real estate",
        description="The municipal corporation ward (and zone, where mapped) holding each lived-in block's centre, from DataMeet's "
                    "Municipal Spatial Data (github.com/datameet/Municipal_Spatial_Data). Each city's map has its own vintage "
                    f"({region}: {vint or 'not stated'}); several corporations have redrawn wards since, so use it to join ward-level budgets, "
                    "grievances and election results of that map, not as today's legal limit.",
        source="pipeline/realestate/wards.py (DataMeet Municipal Spatial Data via DuckDB spatial)",
        license="CC BY 4.0 (DataMeet Municipal Spatial Data)", default_field="ward", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        if r not in SOURCES:
            print(f"{r}: no ward map")
            continue
        rows = fetch(r)
        print(f"{r}: {len(rows)} blocks in {len({x.get('ward_no') for x in rows.values()})} wards of {SOURCES[r][0]}")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
