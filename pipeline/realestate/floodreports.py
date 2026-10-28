"""Reported flood spots and past flood extents per block (OpenCity public-domain city flood maps).

Per L7 lived-in block (dataset ``flood_reports``):

    flood_spots        reported flooding, stagnation and low-lying points within SPOT_M (all sources)
    flood_events       distinct events that reached the block: a reported spot within SPOT_M or, for 2005 and 2015,
                       half the block inside the mapped extent (events: 2005, 2015, 2020, and 'recurring' or
                       'low-lying' lists, each counted once)
    flooded_2015_pct   share of the block inside the mapped 2015 inundation zone (Chennai)
    flooded_2005_pct   share of the block inside the mapped 2005 flood extent (Chennai)
    flooded_streets_2015  crowd-sourced flooded street segments of December 2015 touching the block (Chennai)

Sources are KML maps on data.opencity.in marked public domain: Greater Chennai Corporation flood hotspots (2005, 2015,
2020 Cyclone Nivar), 2015 stagnation points, district hotspots, the 2015 inundation zone and 2005 extent, the 2015
crowd-sourced flooded streets, Hyderabad's inundation points, and Bengaluru's flood-vulnerable, flood-prone and BBMP
low-lying locations. Other cities have no such map there. These are places officials or residents reported, not
modelled hazard; unreported flooding is missing.

    python -m pipeline.realestate.floodreports --region chennai,hyderabad,bengaluru
"""
from __future__ import annotations

import argparse
import math
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
SPOT_M = 300
OC = "https://data.opencity.in/dataset/"

# (region, kind, event, resource path under OC)
SOURCES = [
    ("chennai", "points", "recurring", "022dd080-e927-40d7-897d-adf3ee98ad69/resource/ceddf53f-03c0-4866-8ba8-5e84c8007a85/download/814ca028-4c84-4bd0-aa67-6dbaeb9b6ba5.kml"),
    ("chennai", "points", "2015", "022dd080-e927-40d7-897d-adf3ee98ad69/resource/80ed2fa7-1150-4f55-8125-682ab55282ac/download/93d2905a-a580-482d-96b0-4d9ccf5273ef.kml"),
    ("chennai", "points", "2005", "bdae9914-f0e6-46e1-ad26-ed4ad4f5251a/resource/eeb91a74-eeab-4398-bc87-cc1423c83785/download/7cbcb0b1-7561-4e03-acab-b08ec68a838a.kml"),
    ("chennai", "extent", "2005", "bdae9914-f0e6-46e1-ad26-ed4ad4f5251a/resource/5a5a41fd-d7f5-442a-a523-d58e3b6ef53a/download/c49407c8-1c03-4646-a3ba-0ddb16da0d9f.kml"),
    ("chennai", "streets", "2015", "866141ab-3a3f-4dc0-8092-421d97ba29a2/resource/782a2e52-78ac-4f89-b469-28a6f7d365eb/download/46d6c279-ae09-43a8-8691-7a5386f69e3a.kml"),
    ("chennai", "points", "2015", "866141ab-3a3f-4dc0-8092-421d97ba29a2/resource/8e1c5b2d-322c-4dbd-bd64-6da2d1a8681d/download/31523c86-0ad1-42f5-b4d1-297daa4bbcd6.kml"),
    ("chennai", "points", "2015", "866141ab-3a3f-4dc0-8092-421d97ba29a2/resource/ec58c238-b760-474a-93f5-181abc8d45e9/download/d8d3ac1d-b486-4446-bc76-3dff0af8cbdb.kml"),
    ("chennai", "extent", "2015", "866141ab-3a3f-4dc0-8092-421d97ba29a2/resource/2056abd6-26d7-413b-9dfa-e63cbbf41ee7/download/7cb3cecf-a95a-4786-8032-9c7417655d24.kml"),
    ("chennai", "points", "2015", "866141ab-3a3f-4dc0-8092-421d97ba29a2/resource/e180e7f3-a2bc-4cd5-9883-008c94a24bed/download/3746a11e-620f-40e4-94a1-21ea8fe2a35e.kml"),
    ("chennai", "points", "2020", "3aef2eef-a97e-4fac-a4a9-aaa42a91fbfa/resource/068cfdae-652d-47c9-9722-7c49396d8a05/download/3a141c21-2b9d-4fc0-bd96-d71650a8a15a.kml"),
    ("hyderabad", "points", "recurring", "fbc0cf2e-2c10-4d9a-8dfd-0b1c24c6f279/resource/8ab584c9-19ca-4c1b-945f-f19fe1db5de5/download/d6d078ca-7330-4efe-8a5f-0c74cb6a0a70.kml"),
    ("bengaluru", "points", "recurring", "b03218ea-4b7c-4fa9-ab67-b9054d7ecc4c/resource/a7d8a01f-1fbc-41e1-85f0-f15ea16b2d27/download/6b3c63b0-f461-4e9c-a2c2-006f734c5b41.kml"),
    ("bengaluru", "points", "recurring", "b03218ea-4b7c-4fa9-ab67-b9054d7ecc4c/resource/d90fe768-caba-4c6e-b6b5-a75acd5e88a9/download/00fb1229-dcfd-4f59-813f-885e0c629add.kml"),
    ("bengaluru", "points", "low-lying", "b03218ea-4b7c-4fa9-ab67-b9054d7ecc4c/resource/62ceac3b-f6e2-4dd1-ae9f-be80b1f2fda8/download/8e87a2fc-e014-4c6e-81f1-d5cb4db57a46.kml"),
]
CITIES = sorted({s[0] for s in SOURCES})


def spots_near(cells, points, reach_m=SPOT_M):
    """{code: (count, {events})} for cells [(code, lat, lng)] and points [(lat, lng, event)], via a 0.01° grid."""
    step = 0.01
    grid = {}
    for y, x, ev in points:
        grid.setdefault((math.floor(y / step), math.floor(x / step)), []).append((y, x, ev))
    out = {}
    for code, y, x in cells:
        kx = 111.32 * math.cos(math.radians(y))
        gy, gx = math.floor(y / step), math.floor(x / step)
        n, evs = 0, set()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for py, px, ev in grid.get((gy + dy, gx + dx), ()):
                    if math.hypot((py - y) * 110570, (px - x) * kx * 1000) <= reach_m:
                        n += 1
                        evs.add(ev)
        if n:
            out[code] = (n, evs)
    return out


def _download(path, dest):
    import requests
    r = requests.get(OC + path, timeout=300)
    r.raise_for_status()
    f = Path(dest) / (path.split("/")[-1])
    f.write_bytes(r.content)
    return f


def compute(region, tmp):
    import duckdb

    from pipeline.cells import store
    from pipeline.realestate.powerplants import lived_cells
    cells = lived_cells(region)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    points, extents, streets = [], {}, []
    for reg, kind, ev, path in SOURCES:
        if reg != region:
            continue
        f = _download(path, tmp)
        if kind == "points":
            points += [(y, x, ev) for y, x in con.execute(f"SELECT ST_Y(geom), ST_X(geom) FROM ST_Read('{f}') WHERE ST_GeometryType(geom) = 'POINT' AND NOT ST_IsEmpty(geom)").fetchall() if y is not None]
        elif kind == "extent":
            con.execute(f"CREATE OR REPLACE TABLE x{ev} AS SELECT ST_MakeValid(ST_Force2D(geom)) AS geom FROM ST_Read('{f}')")
            extents[ev] = f"x{ev}"
        else:
            con.execute(f"CREATE OR REPLACE TABLE s{ev} AS SELECT ST_Force2D(geom) AS geom FROM ST_Read('{f}')")
            streets.append(f"s{ev}")
    near = spots_near(cells, points)
    rows = {c: {"flood_spots": n} for c, (n, _) in near.items()}
    events = {c: set(e) for c, (_, e) in near.items()}
    if extents or streets:
        samples = []
        for code, _, _ in cells:
            b = store.cell_bounds(code)
            for fy in (1 / 6, 1 / 2, 5 / 6):
                for fx in (1 / 6, 1 / 2, 5 / 6):
                    samples.append((code, b["south"] + fy * (b["north"] - b["south"]), b["west"] + fx * (b["east"] - b["west"])))
        con.execute("CREATE TABLE p (code VARCHAR, y DOUBLE, x DOUBLE)")
        con.executemany("INSERT INTO p VALUES (?, ?, ?)", samples)
        for ev, t in extents.items():
            for code, k in con.execute(f"SELECT p.code, count(DISTINCT (p.y, p.x)) FROM p JOIN {t} ON ST_Contains({t}.geom, ST_Point(p.x, p.y)) GROUP BY 1").fetchall():
                rows.setdefault(code, {})[f"flooded_{ev}_pct"] = round(100 * k / 9)
                if k >= 5:
                    events.setdefault(code, set()).add(ev)
        for t in streets:
            con.execute("CREATE OR REPLACE TABLE bx AS SELECT code, ST_MakeEnvelope(min(x) - 0.0004, min(y) - 0.0004, max(x) + 0.0004, max(y) + 0.0004) AS g FROM p GROUP BY code")
            for code, k in con.execute(f"SELECT bx.code, count(*) FROM bx JOIN {t} ON ST_Intersects(bx.g, {t}.geom) GROUP BY 1").fetchall():
                rows.setdefault(code, {})["flooded_streets_2015"] = k
    for code, evs in events.items():
        rows.setdefault(code, {})["flood_events"] = len(evs)
    return rows, len(points)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("flood_spots", f"Reported flood spots within {SPOT_M} m", agg="sum", unit="spots", ramp="blues", higher_is="worse"),
        FieldSpec("flood_events", f"Flood events that reached the block (spot within {SPOT_M} m or mapped extent)", agg="max", unit="events", ramp="blues", higher_is="worse"),
        FieldSpec("flooded_2015_pct", "Inside the mapped December 2015 inundation zone", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("flooded_2005_pct", "Inside the mapped 2005 flood extent", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="worse"),
        FieldSpec("flooded_streets_2015", "Crowd-reported flooded street segments, December 2015", agg="sum", unit="segments", ramp="blues", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="flood_reports", title="Reported flood spots and past floods (OpenCity)", level=LEVEL, fields=specs, group="Hazards",
        description="Places officials and residents reported flooding: Greater Chennai Corporation flood hotspots (2005, 2015, 2020), "
                    "2015 stagnation points and district hotspots, the mapped 2015 inundation zone and 2005 extent, crowd-sourced "
                    "flooded streets of December 2015, Hyderabad's inundation points and Bengaluru's flood-vulnerable, flood-prone and "
                    "BBMP low-lying locations, from public-domain maps on data.opencity.in. Reports, not a model: unreported flooding "
                    "is missing and other cities have no such maps there.",
        source="pipeline/realestate/floodreports.py (OpenCity KML maps via DuckDB spatial)",
        license="Public domain (as marked on data.opencity.in)", default_field="flood_spots", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(CITIES))
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        for r in a.region.split(","):
            rows, n = compute(r, tmp)
            print(f"{r}: {n} reported points, {len(rows)} blocks touched, "
                  f"{sum(1 for x in rows.values() if x.get('flood_spots'))} within {SPOT_M} m of a spot")
            if rows:
                cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
