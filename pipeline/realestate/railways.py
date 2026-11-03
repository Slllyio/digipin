"""Railway lines per block from Overture Maps (OpenStreetMap rail), for train noise and severance.

Per L7 lived-in block (dataset ``railways``):

    rail_km         mainline and suburban track in the block (Overture rail classes other than subway, tram and light rail)
    metro_km        metro and light-rail track in the block (at grade, elevated or underground: OSM does not say which here)
    rail_near_pct   share of the block within NEAR_M of a mainline track (loudest: horns, freight, diesel)
    rail_band_pct   share of the block within BAND_M of a mainline track

Without train counts there is no decibel level, so distance bands stand in for exposure.

    python -m pipeline.realestate.railways --region all
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
NEAR_M, BAND_M = 50, 150
METRO_CLASSES = ("subway", "light_rail", "tram", "monorail")


def fetch(region, release=RELEASE):
    """{code: {'rail_m', 'metro_m', 'near_m2', 'band_m2'}} for the lived-in L7 cells of the region."""
    import duckdb

    from pipeline.cells import store
    w, s, e, n = bbox_for(region)
    lat = (s + n) / 2
    kx = math.cos(math.radians(lat))
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET enable_progress_bar=false;")
    metro = ", ".join(f"'{c}'" for c in METRO_CLASSES)
    con.execute(f"""
        CREATE TABLE f AS SELECT geometry AS geom, CASE WHEN class IN ({metro}) THEN 'metro' ELSE 'rail' END AS kind
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*')
        WHERE subtype = 'rail' AND bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}
          AND coalesce(class, '') NOT IN ('funicular', 'disused', 'abandoned')
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
    lines = con.execute(f"""
        SELECT c.code, f.kind, sum(ST_Length(ST_Affine(ST_Intersection(f.geom, {env}), {kx}, 0, 0, 1, 0, 0)))
        FROM c JOIN f ON ST_Intersects(f.geom, {env}) GROUP BY 1, 2
    """).fetchall()
    got = {}
    blank = {"rail_m": 0.0, "metro_m": 0.0, "near_m2": 0.0, "band_m2": 0.0}
    for code, kind, length in lines:
        got.setdefault(code, dict(blank))[f"{kind}_m"] += (length or 0) * M_PER_DEG
    for key, metres in (("near_m2", NEAR_M), ("band_m2", BAND_M)):
        rows = con.execute(f"""
            WITH b AS (SELECT ST_Affine(ST_Buffer(ST_Affine(geom, {kx}, 0, 0, 1, 0, 0), {metres / M_PER_DEG}), {1 / kx}, 0, 0, 1, 0, 0) AS buf
                       FROM f WHERE kind = 'rail')
            SELECT c.code, ST_Area(ST_Intersection(ST_Union_Agg(b.buf), {env}))
            FROM c JOIN b ON ST_Intersects(b.buf, {env}) GROUP BY c.code, c.w, c.s, c.e, c.n
        """).fetchall()
        for code, area in rows:
            got.setdefault(code, dict(blank))[key] = deg2_to_m2(area or 0, lat)
    return got


def rows_for(got):
    from pipeline.cells import store
    rows = []
    for code, x in got.items():
        b = store.cell_bounds(code)
        cell = deg2_to_m2((b["east"] - b["west"]) * (b["north"] - b["south"]), (b["north"] + b["south"]) / 2)
        rows.append({"digipin": code, "rail_km": round(x["rail_m"] / 1000, 3), "metro_km": round(x["metro_m"] / 1000, 3),
                     "rail_near_pct": round(min(100.0, 100 * x["near_m2"] / cell), 1),
                     "rail_band_pct": round(min(100.0, 100 * x["band_m2"] / cell), 1)})
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("rail_km", "Mainline and suburban railway track in the block", agg="sum", unit="km", domain=[0, 0.5], ramp="reds", higher_is=None),
        FieldSpec("metro_km", "Metro and light-rail track in the block", agg="sum", unit="km", domain=[0, 0.5], ramp="viridis", higher_is=None),
        FieldSpec("rail_near_pct", f"Block within {NEAR_M} m of a mainline track", agg="mean", unit="% of block", domain=[0, 100], ramp="reds",
                  higher_is="worse"),
        FieldSpec("rail_band_pct", f"Block within {BAND_M} m of a mainline track", agg="mean", unit="% of block", domain=[0, 100], ramp="reds",
                  higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="railways", title="Railway lines and train noise bands (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"OpenStreetMap railway track via Overture Maps transportation (release {RELEASE}), clipped to each lived-in block: "
                    f"mainline and suburban track (every rail class but subway, light rail, tram and monorail), metro and light rail, "
                    f"and the share of the block within {NEAR_M} m and {BAND_M} m of a mainline track. Yards and sidings count as track.",
        source="pipeline/realestate/railways.py (Overture Maps transportation via DuckDB spatial)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="rail_band_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = rows_for(fetch(r))
        print(f"{r}: {len(rows)} blocks; {sum(x['rail_km'] for x in rows):.0f} km of rail, {sum(x['metro_km'] for x in rows):.0f} km of metro")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
