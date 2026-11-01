"""Road underpasses, subways and flyovers per block from Overture Maps transportation segments (ODbL 1.0, from
OpenStreetMap).

Underpasses are where Indian cities flood first: a dip in the road below the surrounding ground fills in a heavy shower
(Minto Bridge in Delhi, Bengaluru's KR Circle). Overture flags the parts of road segments that run in a tunnel
(``is_tunnel``: underpasses, vehicle subways and road tunnels) or on a bridge (``is_bridge``: flyovers, elevated roads and
river bridges). The flagged part of each segment is placed at its midpoint (dataset ``underpasses``, L7 blocks):

    up_road_n / up_road_m    vehicle-road underpasses and tunnels: count of flagged parts, metres
    up_ped_n                 pedestrian subways (footway, steps, pedestrian or path in a tunnel)
    up_bridge_m              flyover and bridge length on vehicle roads (m)

OpenStreetMap does not separate an underpass from a road tunnel and maps some subways as plain footways, so counts are a
floor. The lens sets underpasses against the waterlogging index.

    env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY python -m pipeline.realestate.underpasses --region delhi
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import bbox_for
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PED = ("footway", "steps", "pedestrian", "path", "cycleway", "bridleway")
SKIP = ("track",)


def kind_of(road_class, flag):
    """Overture road class + flag ('is_tunnel' / 'is_bridge') -> 'road', 'ped', 'bridge' or None."""
    if road_class in SKIP:
        return None
    ped = road_class in PED
    if flag == "is_tunnel":
        return "ped" if ped else "road"
    if flag == "is_bridge" and not ped:
        return "bridge"
    return None


def rows_from(parts):
    """parts [(lat, lng, kind, metres)] -> {L7 code: fields}."""
    out = {}
    for lat, lng, kind, m in parts:
        code = digipin.encode(lat, lng).replace("-", "")[:LEVEL]
        r = out.setdefault(code, {"up_road_n": 0, "up_road_m": 0.0, "up_ped_n": 0, "up_bridge_m": 0.0})
        if kind == "road":
            r["up_road_n"] += 1
            r["up_road_m"] += m
        elif kind == "ped":
            r["up_ped_n"] += 1
        elif kind == "bridge":
            r["up_bridge_m"] += m
    for r in out.values():
        r["up_road_m"], r["up_bridge_m"] = round(r["up_road_m"]), round(r["up_bridge_m"])
    return out


def fetch(region, release=RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    k = 111320 * math.cos(math.radians((s + n) / 2))
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    raw = con.execute(f"""
        WITH r AS (
            SELECT class, unnest(road_flags) AS f, geometry
            FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*')
            WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}
              AND subtype = 'road' AND road_flags IS NOT NULL
        ), p AS (
            SELECT class, CASE WHEN list_contains(f['values'], 'is_tunnel') THEN 'is_tunnel' ELSE 'is_bridge' END AS flag,
                   geometry, coalesce(f.between[1], 0.0) AS a, coalesce(f.between[2], 1.0) AS b
            FROM r WHERE list_contains(f['values'], 'is_tunnel') OR list_contains(f['values'], 'is_bridge')
        )
        SELECT ST_Y(ST_LineInterpolatePoint(geometry, (a + b) / 2)), ST_X(ST_LineInterpolatePoint(geometry, (a + b) / 2)),
               class, flag, ST_Length(geometry) * (b - a)
        FROM p
    """).fetchall()
    parts = []
    for lat, lng, cls, flag, deg in raw:
        kind = kind_of(cls, flag)
        if kind and s <= lat <= n and w <= lng <= e:
            parts.append((lat, lng, kind, deg * k))
    return rows_from(parts)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("up_road_n", "Road underpasses and tunnels (mapped parts)", agg="sum", unit="count", ramp="blues"),
        FieldSpec("up_road_m", "Length of road underground", agg="sum", unit="m", ramp="blues"),
        FieldSpec("up_ped_n", "Pedestrian subways", agg="sum", unit="count", ramp="blues"),
        FieldSpec("up_bridge_m", "Flyover and bridge length on roads", agg="sum", unit="m", ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="underpasses", title="Road underpasses, subways and flyovers (Overture / OpenStreetMap)", level=LEVEL, fields=specs,
        group="Mobility",
        description=f"Parts of road segments flagged as tunnel or bridge in Overture Maps transportation (release {RELEASE}, "
                    "from OpenStreetMap), placed at their midpoint. Underpasses and road tunnels are not told apart; a floor.",
        source="pipeline/realestate/underpasses.py (Overture Maps transportation segments via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap contributors via Overture Maps)", default_field="up_road_n", extrude=False)
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
        v = rows.values()
        print(f"{region}: {sum(r['up_road_n'] for r in v)} road underpass parts ({sum(r['up_road_m'] for r in v) / 1000:.1f} km), "
              f"{sum(r['up_ped_n'] for r in v)} subways, {sum(r['up_bridge_m'] for r in v) / 1000:.0f} km flyovers/bridges; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
