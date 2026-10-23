"""Public green space per block from Overture Maps land use.

Per L7 block (dataset ``parks``), the area of Overture base-theme land-use polygons
that are public green or play space (parks, gardens, recreation grounds,
playgrounds, pitches), clipped to the block:

    park_m2     public green and play space inside the block
    park_pct    the same as a share of the block
    big_park    1 if the block touches a park of at least BIG_PARK_HA

    python -m pipeline.realestate.parks --region all
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
CLASSES = ("park", "garden", "recreation_ground", "playground", "pitch", "dog_park", "village_green", "common")
BIG_PARK_HA = 0.5          # WHO Europe: a green area of at least 0.5 ha within 300 m of home
M_PER_DEG = 111_320.0


def deg2_to_m2(area_deg2, lat):
    """Area in square degrees at latitude ``lat`` → m²."""
    return area_deg2 * M_PER_DEG * M_PER_DEG * math.cos(math.radians(lat))


def fetch(region, release=RELEASE):
    """{code: (park_m2, big)} from clipping Overture green land use to the L7 cells of the region."""
    import duckdb

    from pipeline.cells import store
    w, s, e, n = bbox_for(region)
    lat = (s + n) / 2
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    cls = ", ".join(f"'{c}'" for c in CLASSES)
    con.execute(f"""
        CREATE TABLE g AS SELECT geometry AS geom, ST_Area(geometry) AS a
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=land_use/*')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n} AND class IN ({cls})
    """)
    # Cells come from the population layer, the city's own extent.
    import json
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    codes = store.read_region(CELLS, entry).codes
    rows = []
    for c in codes:
        b = store.cell_bounds(c)
        rows.append((c, b["west"], b["south"], b["east"], b["north"]))
    con.execute("CREATE TABLE c (code VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE, n DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?, ?, ?)", rows)
    out = con.execute("""
        SELECT c.code, sum(ST_Area(ST_Intersection(g.geom, ST_MakeEnvelope(c.w, c.s, c.e, c.n)))), max(g.a)
        FROM c JOIN g ON ST_Intersects(g.geom, ST_MakeEnvelope(c.w, c.s, c.e, c.n))
        GROUP BY c.code
    """).fetchall()
    return {code: (deg2_to_m2(a, lat), deg2_to_m2(big, lat) >= BIG_PARK_HA * 1e4) for code, a, big in out if a}


def cell_dataset(region, got):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    rows = []
    for code, (m2, big) in got.items():
        b = store.cell_bounds(code)
        cell = deg2_to_m2((b["east"] - b["west"]) * (b["north"] - b["south"]), (b["north"] + b["south"]) / 2)
        rows.append({"digipin": code, "park_m2": round(m2), "park_pct": round(min(100.0, 100 * m2 / cell), 1), "big_park": int(big)})
    specs = [
        FieldSpec("park_m2", "Public green and play space (Overture land use)", agg="sum", unit="m²", ramp="greens", higher_is="better"),
        FieldSpec("park_pct", "Share of the block that is public green or play space", agg="mean", unit="%", domain=[0, 50], ramp="greens",
                  higher_is="better"),
        FieldSpec("big_park", f"Touches a park of {BIG_PARK_HA} ha or more", agg="max", unit="yes/no", domain=[0, 1], ramp="greens",
                  higher_is="better"),
    ]
    spec = DatasetSpec(
        id="parks", title="Parks and play space (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"Overture Maps base-theme land use (release {RELEASE}) of class {', '.join(CLASSES)}, clipped to each block. "
                    "Overture land use comes from OpenStreetMap, so it shows mapped public parks and grounds; tree cover on private "
                    "or unmapped land is in the vegetation and land-cover datasets instead. Mapping is fuller in central areas.",
        source="pipeline/realestate/parks.py (Overture Maps base theme via DuckDB spatial)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="park_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        got = fetch(r)
        print(f"{r}: {sum(m for m, _ in got.values()) / 1e6:.1f} km² of parks in {len(got)} blocks")
        if got:
            cell_dataset(r, got)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
