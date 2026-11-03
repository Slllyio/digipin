"""Open drains, canals and wastewater works per block from Overture Maps (OpenStreetMap water features).

Per L7 block (dataset ``drains``):

    drain_km        storm-water drains, nallahs and ditches in the block
    canal_km        canals in the block
    drain_near_pct  share of the block within NEAR_M of a drain or ditch (smell, mosquitoes, overflow)
    wastewater_pct  share of the block covered by wastewater basins (sewage treatment and effluent ponds)
    wastewater      wastewater basins touching the block

OpenStreetMap maps the big nallahs and trunk drains well and the roadside drains hardly at all, so drain
length is a measure of the main network.

    python -m pipeline.realestate.drains --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.realestate.parks import M_PER_DEG, deg2_to_m2
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NEAR_M = 100
DRAIN_CLASSES = ("drain", "ditch")


def fetch(region, release=RELEASE):
    """{code: {'drain_m', 'canal_m', 'near_m2', 'ww_m2', 'ww'}} for the L7 cells of the region."""
    import duckdb

    from pipeline.cells import store
    w, s, e, n = bbox_for(region)
    lat = (s + n) / 2
    kx = math.cos(math.radians(lat))
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET enable_progress_bar=false;")
    drains = ", ".join(f"'{c}'" for c in DRAIN_CLASSES)
    con.execute(f"""
        CREATE TABLE f AS SELECT geometry AS geom,
            CASE WHEN class IN ({drains}) THEN 'drain' WHEN class = 'canal' THEN 'canal' ELSE 'wastewater' END AS kind
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=water/*')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}
          AND ((class IN ({drains}, 'canal') AND ST_GeometryType(geometry) IN ('LINESTRING', 'MULTILINESTRING'))
               OR (class = 'wastewater' AND ST_GeometryType(geometry) IN ('POLYGON', 'MULTIPOLYGON')))
    """)
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    cells = []
    for c in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(c)
        cells.append((c, b["west"], b["south"], b["east"], b["north"]))
    con.execute("CREATE TABLE c (code VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE, n DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?, ?, ?)", cells)
    env = "ST_MakeEnvelope(c.w, c.s, c.e, c.n)"
    # Lengths and buffers in a locally east-scaled frame, so a degree means the same distance both ways.
    lines = con.execute(f"""
        SELECT c.code, f.kind, sum(ST_Length(ST_Affine(ST_Intersection(f.geom, {env}), {kx}, 0, 0, 1, 0, 0)))
        FROM c JOIN f ON f.kind <> 'wastewater' AND ST_Intersects(f.geom, {env}) GROUP BY 1, 2
    """).fetchall()
    near = con.execute(f"""
        WITH b AS (SELECT ST_Affine(ST_Buffer(ST_Affine(geom, {kx}, 0, 0, 1, 0, 0), {NEAR_M / M_PER_DEG}), {1 / kx}, 0, 0, 1, 0, 0) AS buf
                   FROM f WHERE kind = 'drain')
        SELECT c.code, ST_Area(ST_Intersection(ST_Union_Agg(b.buf), {env}))
        FROM c JOIN b ON ST_Intersects(b.buf, {env}) GROUP BY c.code, c.w, c.s, c.e, c.n
    """).fetchall()
    ww = con.execute(f"""
        SELECT c.code, sum(ST_Area(ST_Intersection(f.geom, {env}))), count(*)
        FROM c JOIN f ON f.kind = 'wastewater' AND ST_Intersects(f.geom, {env}) GROUP BY 1
    """).fetchall()
    got = {}
    blank = {"drain_m": 0.0, "canal_m": 0.0, "near_m2": 0.0, "ww_m2": 0.0, "ww": 0}
    for code, kind, length in lines:
        got.setdefault(code, dict(blank))[f"{kind}_m"] += (length or 0) * M_PER_DEG
    for code, area in near:
        got.setdefault(code, dict(blank))["near_m2"] = deg2_to_m2(area or 0, lat)
    for code, area, k in ww:
        g = got.setdefault(code, dict(blank))
        g["ww_m2"], g["ww"] = deg2_to_m2(area or 0, lat), k
    return got


def rows_for(got):
    from pipeline.cells import store
    rows = []
    for code, x in got.items():
        b = store.cell_bounds(code)
        cell = deg2_to_m2((b["east"] - b["west"]) * (b["north"] - b["south"]), (b["north"] + b["south"]) / 2)
        rows.append({"digipin": code, "drain_km": round(x["drain_m"] / 1000, 3), "canal_km": round(x["canal_m"] / 1000, 3),
                     "drain_near_pct": round(min(100.0, 100 * x["near_m2"] / cell), 1),
                     "wastewater_pct": round(min(100.0, 100 * x["ww_m2"] / cell), 1), "wastewater": x["ww"]})
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("drain_km", "Storm-water drains, nallahs and ditches in the block", agg="sum", unit="km", domain=[0, 0.5], ramp="blues", higher_is=None),
        FieldSpec("canal_km", "Canals in the block", agg="sum", unit="km", domain=[0, 0.5], ramp="blues", higher_is=None),
        FieldSpec("drain_near_pct", f"Block within {NEAR_M} m of a drain or nallah", agg="mean", unit="% of block", domain=[0, 100], ramp="heat",
                  higher_is=None),
        FieldSpec("wastewater_pct", "Wastewater basins (sewage treatment, effluent ponds)", agg="mean", unit="% of block", domain=[0, 30],
                  ramp="reds", higher_is=None),
        FieldSpec("wastewater", "Wastewater basins touching the block", agg="sum", unit="count", domain=[0, 3], ramp="reds", higher_is=None),
    ]
    spec = DatasetSpec(
        id="drains", title="Drains, canals and wastewater works (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"OpenStreetMap water features via Overture Maps (release {RELEASE}): drains and ditches (the nallahs and trunk "
                    f"storm drains; roadside drains are rarely mapped), canals, and wastewater basins of sewage treatment plants and "
                    f"effluent ponds, clipped to each block, with the share of the block within {NEAR_M} m of a drain.",
        source="pipeline/realestate/drains.py (Overture Maps base water via DuckDB spatial)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="drain_near_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = rows_for(fetch(r))
        km = sum(x["drain_km"] for x in rows)
        print(f"{r}: {len(rows)} blocks; {km:.0f} km of drain, {sum(x['canal_km'] for x in rows):.0f} km of canal, "
              f"{sum(x['wastewater'] for x in rows)} wastewater basin pieces")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
