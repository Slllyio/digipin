"""Official land use per block from KSRSAC's 2017 urban land use map of Bengaluru (OpenCity, public domain).

Per L7 block (dataset ``landuse_2017``), each a share of the block's ground in 2017, %:

    residential_pct   residential areas
    commercial_pct    commercial areas
    industrial_pct    industrial areas
    vacant_pct        vacant land and laid-out but unbuilt layouts
    civic_pct         schools, colleges, universities, hospitals, places of worship, utilities
    green_pct         parks, gardens, playgrounds, recreational and vegetated land, plantations, scrub
    farm_pct          crop land, fallow land and farm ponds
    water_pct         tanks, ponds, streams, rivers, wetlands, storm-water drains
    road_pct          roads, rail and transport nodes

Map: the Karnataka State Remote Sensing Applications Centre's 2017 land use and land cover map of the BBMP area (about
157,000 polygons, read on its ULU and level 1-3 classes). Each block is sampled on a 6 x 6 grid of points (about 40 m
apart) and each point takes the class of the polygon holding it (DuckDB spatial).

    python -m pipeline.realestate.landuse2017
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
GRID = 6
URL = ("https://data.opencity.in/dataset/09e78352-3d70-4540-b162-b491f92caff0/resource/acc1fe83-9c73-409d-bde6-8019f4665e46/"
       "download/bac3b524-9acd-44e1-90ef-aaf4582fd990.kmz")
PLACEMARK = re.compile(r"<Placemark\b[^>]*>(.*?)</Placemark>", re.S)
DATA = re.compile(r'<SimpleData name="(\w+)">([^<]*)<')
POLY = re.compile(r"<Polygon>(.*?)</Polygon>", re.S)
OUTER = re.compile(r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", re.S)
INNER = re.compile(r"<innerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", re.S)
CLASSES = ("residential", "commercial", "industrial", "vacant", "civic", "green", "farm", "water", "road")


def classify(p):
    """One of CLASSES (or None) from the map's ULU and level 1-3 descriptions."""
    ulu, d1, d2, d3 = (p.get(k, "").strip().lower() for k in ("ULU", "LULC_Desc_1", "LULC_Desc_2", "LULC_Desc_3"))
    if ulu.startswith("residential") or d2.startswith("built-up (rural)"):
        return "residential"
    if ulu.startswith("commercial"):
        return "commercial"
    if ulu.startswith("industrial") or d2 in ("industrial", "quarry / brick kilns"):
        return "industrial"
    if ulu in ("vacant land", "layout") or d3 == "vacant land":
        return "vacant"
    if d1 in ("water bodies", "wetlands") or d3 == "storm water drain":
        return "water"
    if d2.startswith("transportation") or ulu == "road" or d2.startswith("under construction - linear"):
        return "road"
    if d2 in ("educational", "religious", "utilities", "public / semi public") or "hospital" in d3 or d3 in ("school / colleges", "university"):
        return "civic"
    if d2 in ("crop land", "fallow land", "farm pond", "poultry farm") or d3 in ("crop land", "fallow land"):
        return "farm"
    if d2 in ("recreational", "plantation", "scrub land", "forest plantation") or d1 in ("forest", "wastelands") or "vegetated" in d3:
        return "green"
    return None


def ring(text):
    return [tuple(map(float, xy.split(",")[:2])) for xy in text.split() if "," in xy]


def polygons(text):
    """Yield (class, GeoJSON MultiPolygon) per placemark the classes cover."""
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        cls = classify(dict(DATA.findall(body)))
        if not cls:
            continue
        polys = []
        for pg in POLY.finditer(body):
            o = OUTER.search(pg.group(1))
            if not o:
                continue
            rings = [ring(o.group(1))] + [ring(h) for h in INNER.findall(pg.group(1))]
            rings = [r + ([r[0]] if r and r[0] != r[-1] else []) for r in rings]
            if len(rings[0]) >= 4:
                polys.append([r for r in rings if len(r) >= 4])
        if polys:
            yield cls, {"type": "MultiPolygon", "coordinates": polys}


def sample_points(cells, grid=GRID):
    """(code, lng, lat) on a grid x grid lattice inside each block."""
    from pipeline.cells.store import cell_bounds
    for c in cells:
        b = cell_bounds(c)
        for i in range(grid):
            for j in range(grid):
                yield c, b["west"] + (i + 0.5) * (b["east"] - b["west"]) / grid, b["south"] + (j + 0.5) * (b["north"] - b["south"]) / grid


def shares(cells, polys, grid=GRID):
    """{code: {class_pct: share}} from point sampling against the polygons (DuckDB spatial)."""
    import json

    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE p (k INTEGER, geom GEOMETRY)")
    kinds = []
    for k, (cls, g) in enumerate(polys):
        kinds.append(cls)
        try:
            con.execute("INSERT INTO p VALUES (?, ST_MakeValid(ST_GeomFromGeoJSON(?)))", [k, json.dumps(g)])
        except duckdb.Error:
            continue
    con.execute("CREATE INDEX p_idx ON p USING RTREE (geom)")
    con.execute("CREATE TABLE s (code VARCHAR, x DOUBLE, y DOUBLE)")
    con.executemany("INSERT INTO s VALUES (?, ?, ?)", list(sample_points(cells, grid)))
    hits = con.execute("SELECT s.code, s.x, s.y, min(p.k) FROM s JOIN p ON ST_Contains(p.geom, ST_Point(s.x, s.y)) GROUP BY 1, 2, 3").fetchall()
    out = {}
    per = 100 / grid ** 2
    for code, _, _, k in hits:
        r = out.setdefault(code, {})
        key = f"{kinds[k]}_pct"
        r[key] = r.get(key, 0) + per
    return out


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    labels = {"residential": "Residential", "commercial": "Commercial", "industrial": "Industrial",
              "vacant": "Vacant land and unbuilt layouts", "civic": "Schools, colleges, worship and utilities",
              "green": "Parks, playgrounds, plantations and scrub", "farm": "Crop and fallow land",
              "water": "Lakes, ponds, streams and drains", "road": "Roads and rail"}
    better = {"green", "water"}
    specs = [FieldSpec(f"{k}_pct", f"{v} (2017 land use)", agg="mean", unit="%", domain=[0, 100],
                       ramp="greens" if k in better else "viridis", higher_is="better" if k in better else None) for k, v in labels.items()]
    spec = DatasetSpec(
        id="landuse_2017", title="Official land use 2017 (KSRSAC, Bengaluru)", level=LEVEL, fields=specs, group="Real estate",
        description="Share of each block in residential, commercial, industrial, vacant, civic, green, farm, water and road use "
                    "in 2017, from the Karnataka State Remote Sensing Applications Centre's urban land use map of the BBMP area "
                    "on data.opencity.in.",
        source="pipeline/realestate/landuse2017.py (OpenCity KSRSAC Bengaluru urban land use 2017 via DuckDB spatial)",
        license="Public domain (KSRSAC via data.opencity.in)", default_field="vacant_pct", extrude=False)
    recs = [{"digipin": c, **{k: round(v, 1) for k, v in r.items()}} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import os
    import tempfile

    from pipeline.realestate.bdalayouts import region_cells
    from pipeline.realestate.sewers import download, read_kml
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--map", help="the downloaded KMZ (fetched when left out)")
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        src = a.map or os.path.join(tmp, "landuse2017.kmz")
        if not os.path.exists(src):
            download(URL, src)
        polys = list(polygons(read_kml(src)))
    xs = [p[0] for _, g in polys for poly in g["coordinates"] for p in poly[0]]
    ys = [p[1] for _, g in polys for poly in g["coordinates"] for p in poly[0]]
    w, e, s, n = min(xs), max(xs), min(ys), max(ys)
    cells = []
    for c, lat, lng in region_cells("bengaluru"):
        if w <= lng <= e and s <= lat <= n:
            cells.append(c)
    got = shares(cells, polys)
    info = cell_dataset("bengaluru", got)
    count = {}
    for cls, _ in polys:
        count[cls] = count.get(cls, 0) + 1
    print("bengaluru:", count, f"{len(got)} blocks sampled, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
