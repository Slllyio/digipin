"""High-voltage power lines, their right-of-way corridors and substations per block, from Overture Maps.

Overture's base-theme infrastructure carries OpenStreetMap power lines with their voltage tag. Each line is
buffered to half the right-of-way width the Ministry of Power's 2015 compensation guidelines give for its
voltage (the strip where trees are cut and building is restricted under the CEA safety regulations) and
clipped to each L7 block (dataset ``power_lines``):

    line_km        length of high-voltage line (66 kV and over) in the block
    corridor_pct   share of the block inside a line's right-of-way
    max_kv         highest line voltage crossing the block
    substations    substations mapped in the block

    python -m pipeline.realestate.powerlines --region all
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
MIN_KV = 66
# Right-of-way width (m) by line voltage, MoP guidelines of 15 Oct 2015 (double-circuit where it differs).
ROW_M = ((765, 67), (400, 46), (220, 35), (132, 27), (110, 22), (66, 18))
UNKNOWN_KV = 132                 # untagged lines: assume the commonest urban transmission voltage


def kv_of(tag):
    """Highest voltage in kV from an OSM voltage tag such as '220000' or '220000;66000'; None when absent."""
    vals = []
    for part in str(tag or "").replace(",", ";").split(";"):
        try:
            vals.append(float(part.strip()) / 1000)
        except ValueError:
            continue
    return max(vals) if vals else None


def row_m(kv):
    """Right-of-way width in metres for a line of ``kv`` kV."""
    for floor, width in ROW_M:
        if kv >= floor:
            return width
    return ROW_M[-1][1]


def fetch(region, release=RELEASE):
    """{code: {'line_m', 'corridor_m2', 'max_kv', 'substations'}} for the L7 cells of the region."""
    import duckdb

    from pipeline.cells import store
    w, s, e, n = bbox_for(region)
    lat = (s + n) / 2
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    src = f"read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=infrastructure/*')"
    box = f"bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}"
    lines = con.execute(f"SELECT ST_AsWKB(geometry), source_tags['voltage'] FROM {src} WHERE {box} AND class = 'power_line'").fetchall()
    subs = con.execute(f"SELECT ST_X(ST_Centroid(geometry)), ST_Y(ST_Centroid(geometry)) FROM {src} WHERE {box} AND class = 'substation'").fetchall()
    con.execute("CREATE TABLE l (geom GEOMETRY, kv DOUBLE, half_deg DOUBLE)")
    rows = []
    for wkb, tag in lines:
        kv = kv_of(tag[0] if isinstance(tag, list) else tag)
        kv = UNKNOWN_KV if kv is None else kv
        if kv < MIN_KV:
            continue
        rows.append((bytes(wkb), kv, row_m(kv) / 2 / M_PER_DEG))
    con.executemany("INSERT INTO l VALUES (ST_GeomFromWKB(?), ?, ?)", rows)
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    cells = []
    for c in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(c)
        cells.append((c, b["west"], b["south"], b["east"], b["north"]))
    con.execute("CREATE TABLE c (code VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE, n DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?, ?, ?)", cells)
    # Buffers in degrees are stretched east-west by 1/cos(lat); scale x before buffering so the corridor is round.
    kx = math.cos(math.radians(lat))
    out = con.execute(f"""
        WITH b AS (SELECT kv, geom, ST_Affine(ST_Buffer(ST_Affine(geom, {kx}, 0, 0, 1, 0, 0), half_deg), {1 / kx}, 0, 0, 1, 0, 0) AS buf FROM l)
        SELECT c.code,
               sum(ST_Length(ST_Affine(ST_Intersection(b.geom, ST_MakeEnvelope(c.w, c.s, c.e, c.n)), {kx}, 0, 0, 1, 0, 0))),
               ST_Area(ST_Intersection(ST_Union_Agg(b.buf), ST_MakeEnvelope(c.w, c.s, c.e, c.n))),
               max(b.kv)
        FROM c JOIN b ON ST_Intersects(b.buf, ST_MakeEnvelope(c.w, c.s, c.e, c.n))
        GROUP BY c.code, c.w, c.s, c.e, c.n
    """).fetchall()
    got = {}
    for code, length_deg, area_deg2, kv in out:
        got[code] = {"line_m": (length_deg or 0) * M_PER_DEG, "corridor_m2": deg2_to_m2(area_deg2 or 0, lat), "max_kv": kv, "substations": 0}
    for x, y in subs:
        code = store.cell_code(LEVEL, y, x)
        if code:
            got.setdefault(code, {"line_m": 0.0, "corridor_m2": 0.0, "max_kv": None, "substations": 0})["substations"] += 1
    return got, len(rows), len(subs)


def rows_for(got):
    from pipeline.cells import store
    rows = []
    for code, x in got.items():
        b = store.cell_bounds(code)
        cell = deg2_to_m2((b["east"] - b["west"]) * (b["north"] - b["south"]), (b["north"] + b["south"]) / 2)
        rows.append({"digipin": code, "line_km": round(x["line_m"] / 1000, 3), "corridor_pct": round(min(100.0, 100 * x["corridor_m2"] / cell), 1),
                     "max_kv": round(x["max_kv"]) if x["max_kv"] else None, "substations": x["substations"]})
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("line_km", f"High-voltage line ({MIN_KV} kV and over) in the block", agg="sum", unit="km", domain=[0, 1], ramp="heat", higher_is=None),
        FieldSpec("corridor_pct", "Block inside a power line's right-of-way", agg="mean", unit="% of block", domain=[0, 60], ramp="reds",
                  higher_is="worse"),
        FieldSpec("max_kv", "Highest line voltage crossing the block", agg="max", unit="kV", domain=[66, 765], ramp="heat", higher_is=None),
        FieldSpec("substations", "Substations mapped in the block", agg="sum", unit="count", domain=[0, 3], ramp="viridis", higher_is=None),
    ]
    widths = ", ".join(f"{kv} kV {m} m" for kv, m in reversed(ROW_M))
    spec = DatasetSpec(
        id="power_lines", title="High-voltage lines and corridors (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"OpenStreetMap power lines via Overture Maps (release {RELEASE}), {MIN_KV} kV and over, buffered to the right-of-way "
                    f"width in the Ministry of Power's 2015 guidelines ({widths}; untagged lines taken as {UNKNOWN_KV} kV). Inside the "
                    "corridor, trees are cut and the CEA safety regulations set minimum clearances that rule out most building. "
                    "Lines that are not mapped, or run underground, are missing.",
        source="pipeline/realestate/powerlines.py (Overture Maps base infrastructure via DuckDB spatial)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="corridor_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        got, n_lines, n_subs = fetch(r)
        rows = rows_for(got)
        km = sum(x["line_km"] for x in rows)
        print(f"{r}: {n_lines} HV lines, {n_subs} substations; {km:.0f} km of line over {len(rows)} blocks")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
