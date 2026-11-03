"""Big estates behind walls: defence, railway and golf land per block from Overture Maps land use (ODbL 1.0, from
OpenStreetMap).

Indian cities hold large estates that are closed to the public and outside the municipal plan: cantonments and other
defence land, railway yards and colonies, and golf courses (often on leased government land). These shape where a city can
grow and where land might one day be released or redeveloped (railway land monetisation, cantonment excision). Overture
base-theme land use classes (clipped to each block):

    military    subtype military: military, airfield, training_area, barracks, range, ...
    rail        class railway (yards, sidings and railway colonies mapped as railway land use)
    golf        subtype golf: golf_course and its parts

Per L7 block that touches any of them (dataset ``closed_land``):

    cl_military_pct / cl_rail_pct / cl_golf_pct   share of the block (%)
    cl_closed_pct                                 all three together (%)
    cl_big_estate                                 1 if the block touches a single estate of ``BIG_HA`` or more

OpenStreetMap maps defence land unevenly (it is sometimes left blank on purpose), so this is a floor.

    env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY python -m pipeline.realestate.closedland --region delhi
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline._lib.regions import bbox_for
from pipeline.realestate.parks import deg2_to_m2
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
BIG_HA = 50.0
KINDS = ("military", "rail", "golf")


def kind_sql():
    return ("CASE WHEN subtype = 'military' THEN 'military' WHEN class = 'railway' THEN 'rail' "
            "WHEN subtype = 'golf' THEN 'golf' END")


def rows_from(raw, cell_m2):
    """raw [(code, kind, area_m2, biggest_m2)] -> {code: fields}; ``cell_m2(code)`` gives a block's area."""
    acc = {}
    for code, kind, a, big in raw:
        r = acc.setdefault(code, {"m": {k: 0.0 for k in KINDS}, "big": 0.0})
        r["m"][kind] += a
        r["big"] = max(r["big"], big)
    out = {}
    for code, r in acc.items():
        cm = cell_m2(code)
        f = {f"cl_{k}_pct": round(min(100.0, 100 * r["m"][k] / cm), 1) for k in KINDS}
        f["cl_closed_pct"] = round(min(100.0, sum(100 * r["m"][k] / cm for k in KINDS)), 1)
        f["cl_big_estate"] = int(r["big"] >= BIG_HA * 1e4)
        if f["cl_closed_pct"] >= 0.5:
            out[code] = f
    return out


def fetch(region, release=RELEASE):
    import duckdb

    from pipeline.realestate.powerplants import lived_cells
    from pipeline.cells import store
    w, s, e, n = bbox_for(region)
    lat = (s + n) / 2
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    con.execute(f"""
        CREATE TABLE g AS SELECT {kind_sql()} AS kind, geometry AS geom, ST_Area(geometry) AS a
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=land_use/*')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}
          AND (subtype IN ('military', 'golf') OR class = 'railway')
    """)
    cells = []
    for c, _, _ in lived_cells(region):
        b = store.cell_bounds(c)
        cells.append((c, b["west"], b["south"], b["east"], b["north"]))
    con.execute("CREATE TABLE c (code VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE, n DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?, ?, ?)", cells)
    raw = con.execute("""
        SELECT c.code, g.kind, sum(ST_Area(ST_Intersection(g.geom, ST_MakeEnvelope(c.w, c.s, c.e, c.n)))), max(g.a)
        FROM c JOIN g ON ST_Intersects(g.geom, ST_MakeEnvelope(c.w, c.s, c.e, c.n))
        GROUP BY c.code, g.kind
    """).fetchall()
    raw = [(c, k, deg2_to_m2(a, lat), deg2_to_m2(b, lat)) for c, k, a, b in raw if a]

    def cell_m2(code):
        b = store.cell_bounds(code)
        return deg2_to_m2((b["east"] - b["west"]) * (b["north"] - b["south"]), (b["north"] + b["south"]) / 2)
    return rows_from(raw, cell_m2)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pct = lambda k, label: FieldSpec(k, label, agg="mean", unit="% of block", domain=[0, 100], ramp="reds", higher_is=None)
    specs = [pct("cl_military_pct", "Defence land (Overture/OSM)"), pct("cl_rail_pct", "Railway land"),
             pct("cl_golf_pct", "Golf courses"), pct("cl_closed_pct", "Defence, railway and golf land together"),
             FieldSpec("cl_big_estate", f"Touches a single estate of {BIG_HA:.0f} ha or more", agg="max", unit="yes/no", domain=[0, 1], ramp="reds")]
    spec = DatasetSpec(
        id="closed_land", title="Big estates behind walls: defence, railway and golf land (Overture / OpenStreetMap)", level=LEVEL,
        fields=specs, group="Real estate",
        description=f"Share of each lived-in block covered by defence, railway or golf land in Overture Maps base-theme land use "
                    f"(release {RELEASE}, from OpenStreetMap). Defence land is sometimes left unmapped, so it is a floor.",
        source="pipeline/realestate/closedland.py (Overture Maps base theme land_use via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap contributors via Overture Maps)", default_field="cl_closed_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        rows = fetch(region)
        if not rows:
            print(f"{region}: none")
            continue
        info = cell_dataset(region, rows)
        km2 = {k: 0.0 for k in ("military", "rail", "golf")}
        print(f"{region}: {len(rows)} blocks; military {sum(r['cl_military_pct'] for r in rows.values()):.0f}, rail {sum(r['cl_rail_pct'] for r in rows.values()):.0f}, golf {sum(r['cl_golf_pct'] for r in rows.values()):.0f} block-%; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
