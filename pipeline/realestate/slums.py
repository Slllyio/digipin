"""Mapped slums: share of each block inside a city's own slum boundary map (OpenCity, public domain).

Per lived-in L7 block (dataset ``slums_mapped``):

    slum_pct      share of the block's area inside a mapped slum (%)
    slums         mapped slums touching the block
    notified_pct  share of that slum area the city has notified (declared) as a slum, where the map says (%)

Maps: Greater Chennai Corporation slum boundaries (887), GHMC slums with notified status (1,351), MCGM slum clusters
2015 (2,542) and BBMP slum boundaries with notified status (509). Notified slums have legal recognition and services;
non-notified ones usually do not. Other cities publish lists, not maps.

    python -m pipeline.realestate.slums --region chennai,hyderabad,mumbai,bengaluru
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {     # region: (path, format, year)
    "chennai": ("5ddfadb0-3bb5-4f0f-b00d-3d76cd7e4806/resource/6b9b86ec-0564-4ae0-8e5b-8c27d77e5a2c/download/5959f0f4-8dba-4522-9b5d-f245006220b4.kml", "kml", "GCC"),
    "hyderabad": ("7a85a3cc-5eb6-437f-8ccc-b5858cbce3e5/resource/d3b594ae-a897-47f1-b9c1-7a46f1b62c04/download/098e84e4-b929-4b2e-85f0-7ad9a5203863.kml", "kml", "GHMC"),
    "mumbai": ("14d06506-9463-446a-b28f-d2ce0fd0c131/resource/b85ea681-22c8-406d-9fae-8c0bd28387cf/download/5d6f72ed-a290-4931-821f-5476c148407b.kml", "kml", "MCGM 2015"),
    "bengaluru": ("7f7e9fd2-5192-4ee1-baa4-aff17ecde1cf/resource/f6a01da3-8d5f-45b8-8768-7593278e3ad6/download/bbmp_bangalore_slum_boundaries.geojson", "geojsonl", "BBMP"),
}
MIN_PCT = 1.0


def notified(props):
    """True / False when the map records the slum's legal status, else None."""
    v = (props.get("NOTIFIED_N") or props.get("Slum_Type") or "").strip().lower().replace("_", "-")
    if not v:
        return None
    return not v.startswith(("non", "un", "not "))


def features(region):
    import requests

    from pipeline.realestate.wards import kml_features
    path, fmt, _ = SOURCES[region]
    text = requests.get(OPENCITY + path, timeout=300).content.decode("utf-8-sig")
    if fmt == "kml":
        return kml_features(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]     # one Feature per line


def cell_boxes(region):
    from pipeline.cells import store
    from pipeline.realestate.powerplants import lived_cells
    out = []
    for code, _, _ in lived_cells(region):
        b = store.cell_bounds(code)
        out.append((code, b["west"], b["south"], b["east"], b["north"]))
    return out


def overlay(feats, boxes):
    """{code: row} for blocks with at least MIN_PCT of their area in a mapped slum."""
    import duckdb

    from pipeline.realestate.wards import closed
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE s (k INTEGER, notified INTEGER, geom GEOMETRY)")
    rows = []
    for k, f in enumerate(feats):
        g = closed(f["geometry"]) if f.get("geometry") else None
        if g:
            n = notified(f.get("properties") or {})
            rows.append((k, None if n is None else int(n), json.dumps(g)))
    con.executemany("INSERT INTO s VALUES (?, ?, ST_MakeValid(ST_GeomFromGeoJSON(?)))", rows)
    con.execute("CREATE TABLE c (code VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE, n DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?, ?, ?)", boxes)
    q = """
        WITH b AS (SELECT code, ST_MakeEnvelope(w, s, e, n) AS box FROM c),
        hit AS (SELECT b.code, s.k, s.notified, ST_Area(ST_Intersection(b.box, s.geom)) / ST_Area(b.box) AS f
                FROM b JOIN s ON ST_Intersects(b.box, s.geom))
        SELECT code, least(1.0, sum(f)), count(DISTINCT k), sum(f) FILTER (WHERE notified = 1), sum(f) FILTER (WHERE notified IS NOT NULL)
        FROM hit GROUP BY 1"""
    out = {}
    for code, f, n, fn, fk in con.execute(q).fetchall():
        pct = 100 * f
        if pct < MIN_PCT:
            continue
        row = {"slum_pct": round(pct, 1), "slums": int(n)}
        if fk:
            row["notified_pct"] = round(100 * (fn or 0) / fk)
        out[code] = row
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("slum_pct", "Block area inside a mapped slum", agg="mean", unit="%", domain=[0, 100], ramp="heat"),
        FieldSpec("slums", "Mapped slums touching the block", agg="sum", unit="slums", ramp="heat"),
        FieldSpec("notified_pct", "Slum area notified (legally declared)", agg="mean", unit="%", domain=[0, 100], ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="slums_mapped", title="Mapped slums (city slum boundary maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Share of each lived-in block inside a slum on the city's own boundary map, how many mapped slums touch it, "
                    "and how much of that slum area is notified (legally declared), where the map records it. Maps on "
                    "data.opencity.in: Greater Chennai Corporation, GHMC Hyderabad (with notified status), MCGM slum clusters "
                    "2015 and BBMP Bengaluru (with notified status). Blocks under 1% slum are left out.",
        source="pipeline/realestate/slums.py (OpenCity slum maps via DuckDB spatial)",
        license="Public domain (city corporations via data.opencity.in)", default_field="slum_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        feats = features(r)
        rows = overlay(feats, cell_boxes(r))
        print(f"{r}: {len(feats)} mapped slums; {len(rows)} blocks at least {MIN_PCT}% slum")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
