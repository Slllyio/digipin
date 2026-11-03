"""Private (gated) and one-way streets per block from Overture Maps transportation segments (ODbL 1.0, from OpenStreetMap).

Gated colonies, housing societies, campuses and cantonments close their lanes to the public; OpenStreetMap marks these as
``access=private``, which Overture carries as an access restriction recognised ``as_private``. A street network full of
private lanes is hard to walk through and pushes traffic onto a few main roads. Each road segment is placed at its
midpoint in an L7 block (dataset ``gated_streets``):

    gs_local_km      length of local streets (residential, living street, service, unclassified), km
    gs_private_km    length of those marked private, km
    gs_private_pct   share of local street length that is private (%), where at least 300 m of local street is mapped
    gs_oneway_pct    share of all road length that is one-way (%)

Mappers tag private lanes unevenly, so it is a floor.

    env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY python -m pipeline.realestate.gatedstreets --region delhi
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
LOCAL = ("residential", "living_street", "service", "unclassified")
ROADS = LOCAL + ("motorway", "trunk", "primary", "secondary", "tertiary")
MIN_LOCAL_M = 300.0


def rows_from(segs):
    """segs [(lat, lng, road_class, metres, private, oneway)] -> {L7 code: fields}."""
    acc = {}
    for lat, lng, cls, m, private, oneway in segs:
        if cls not in ROADS:
            continue
        code = digipin.encode(lat, lng).replace("-", "")[:LEVEL]
        a = acc.setdefault(code, [0.0, 0.0, 0.0, 0.0])
        a[2] += m
        a[3] += m if oneway else 0.0
        if cls in LOCAL:
            a[0] += m
            a[1] += m if private else 0.0
    out = {}
    for code, (loc, prv, allm, one) in acc.items():
        r = {"gs_local_km": round(loc / 1000, 2), "gs_private_km": round(prv / 1000, 2),
             "gs_oneway_pct": round(100 * one / allm, 1) if allm else None}
        if loc >= MIN_LOCAL_M:
            r["gs_private_pct"] = round(100 * prv / loc, 1)
        out[code] = {k: v for k, v in r.items() if v is not None}
    return out


def fetch(region, release=RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    k = 111320 * math.cos(math.radians((s + n) / 2))
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    raw = con.execute(f"""
        SELECT ST_Y(ST_LineInterpolatePoint(geometry, 0.5)), ST_X(ST_LineInterpolatePoint(geometry, 0.5)), class, ST_Length(geometry),
               coalesce(list_bool_or(list_transform(access_restrictions, lambda x: x.access_type = 'allowed'
                   AND list_contains(coalesce(x."when".recognized, []), 'as_private'))), false),
               coalesce(list_bool_or(list_transform(access_restrictions, lambda x: x.access_type = 'denied'
                   AND x."when".heading IS NOT NULL AND x."when".mode IS NULL AND x."when".vehicle IS NULL)), false)
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n} AND subtype = 'road'
    """).fetchall()
    return rows_from([(la, ln, c, d * k, bool(p), bool(o)) for la, ln, c, d, p, o in raw if s <= la <= n and w <= ln <= e])


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("gs_local_km", "Local streets mapped", agg="sum", unit="km", ramp="viridis"),
        FieldSpec("gs_private_km", "Local streets marked private (gated)", agg="sum", unit="km", ramp="reds"),
        FieldSpec("gs_private_pct", "Share of local streets that are private", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("gs_oneway_pct", "Share of road length that is one-way", agg="mean", unit="%", domain=[0, 100], ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="gated_streets", title="Private (gated) and one-way streets (Overture / OpenStreetMap)", level=LEVEL, fields=specs,
        group="Mobility",
        description=f"Road segments in Overture Maps transportation (release {RELEASE}, from OpenStreetMap) placed at their midpoint; "
                    "local streets with an access restriction recognised as private, and one-way roads. Private lanes are tagged "
                    "unevenly, so a floor.",
        source="pipeline/realestate/gatedstreets.py (Overture Maps transportation segments via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap contributors via Overture Maps)", default_field="gs_private_pct", extrude=False)
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
        loc, prv = sum(r["gs_local_km"] for r in v), sum(r["gs_private_km"] for r in v)
        print(f"{region}: local {loc:.0f} km, private {prv:.0f} km ({100 * prv / max(loc, 1):.1f}%); {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
