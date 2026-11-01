"""Roads being built now, per block, from Overture Maps transportation segments (ODbL 1.0, from OpenStreetMap).

Mappers mark roads, flyovers and links that are under construction (OSM highway=construction), which Overture carries as
the ``is_under_construction`` road flag on part or all of a segment. New arterial roads change access and land prices
before they open. Each flagged part is cut into ~50 m pieces placed in the blocks they cross (dataset ``roads_building``, L7 blocks):

    rb_major_m     arterial roads under construction: motorway, trunk, primary, secondary (m)
    rb_minor_m     other roads under construction: tertiary, residential, service, unclassified and links (m)
    rb_elevated_m  of which elevated (also flagged bridge: flyovers, elevated corridors) (m)

Some sites stay tagged long after they open and many are never tagged, so it is a snapshot of the map, not a project list
(see `new_roads` for named projects).

    env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY python -m pipeline.realestate.roadsbuilding --region delhi
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
MAJOR = ("motorway", "trunk", "primary", "secondary")
MINOR = ("tertiary", "residential", "service", "unclassified", "living_street", "unknown")


def kind_of(road_class):
    """Overture road class -> 'major', 'minor' or None (paths, footways and tracks are left out)."""
    if road_class in MAJOR:
        return "major"
    if road_class in MINOR:
        return "minor"
    return None


def pieces(wkt, m_per_deg_lng, step_m=50.0):
    """LINESTRING WKT -> [(lat, lng, metres)] pieces of about ``step_m``, so long segments spread over the blocks they cross."""
    if not wkt or not wkt.startswith("LINESTRING"):
        return []
    pts = [tuple(map(float, p.split())) for p in wkt[wkt.index("(") + 1:wkt.rindex(")")].split(",")]
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        d = math.hypot((x1 - x0) * m_per_deg_lng, (y1 - y0) * 110540)
        k = max(1, int(math.ceil(d / step_m)))
        for j in range(k):
            t = (j + 0.5) / k
            out.append((y0 + (y1 - y0) * t, x0 + (x1 - x0) * t, d / k))
    return out


def rows_from(parts):
    """parts [(lat, lng, road_class, metres, elevated)] -> {L7 code: fields}."""
    out = {}
    for lat, lng, cls, m, elevated in parts:
        k = kind_of(cls)
        if not k:
            continue
        code = digipin.encode(lat, lng).replace("-", "")[:LEVEL]
        r = out.setdefault(code, {"rb_major_m": 0.0, "rb_minor_m": 0.0, "rb_elevated_m": 0.0})
        r[f"rb_{k}_m"] += m
        if elevated:
            r["rb_elevated_m"] += m
    return {c: {k: round(v) for k, v in r.items()} for c, r in out.items() if r["rb_major_m"] + r["rb_minor_m"] >= 20}


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
            SELECT class, list_contains(f['values'], 'is_bridge') AS elevated, geometry,
                   coalesce(f.between[1], 0.0) AS a, coalesce(f.between[2], 1.0) AS b
            FROM r WHERE list_contains(f['values'], 'is_under_construction')
        )
        SELECT ST_AsText(ST_LineSubstring(geometry, a, b)), class, elevated FROM p
    """).fetchall()
    parts = []
    for wkt, cls, el in raw:
        for la, ln, m in pieces(wkt, k):
            if s <= la <= n and w <= ln <= e:
                parts.append((la, ln, cls, m, bool(el)))
    return rows_from(parts)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("rb_major_m", "Arterial road under construction", agg="sum", unit="m", ramp="viridis"),
        FieldSpec("rb_minor_m", "Other road under construction", agg="sum", unit="m", ramp="viridis"),
        FieldSpec("rb_elevated_m", "Elevated road or flyover under construction", agg="sum", unit="m", ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="roads_building", title="Roads being built now (Overture / OpenStreetMap)", level=LEVEL, fields=specs,
        group="Mobility",
        description=f"Parts of road segments flagged under construction in Overture Maps transportation (release {RELEASE}, from "
                    "OpenStreetMap), spread over the blocks they cross. A snapshot of the map: some sites stay tagged after opening.",
        source="pipeline/realestate/roadsbuilding.py (Overture Maps transportation segments via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap contributors via Overture Maps)", default_field="rb_major_m", extrude=False)
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
        print(f"{region}: major {sum(r['rb_major_m'] for r in v) / 1000:.1f} km, minor {sum(r['rb_minor_m'] for r in v) / 1000:.1f} km, "
              f"elevated {sum(r['rb_elevated_m'] for r in v) / 1000:.1f} km; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
