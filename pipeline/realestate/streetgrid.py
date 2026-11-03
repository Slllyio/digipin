"""Street connectivity per block: intersections and dead ends from Overture Maps transportation (ODbL, from OpenStreetMap).

Every Overture road segment lists the connectors it touches and where along it they sit. A connector's degree is the
number of street ends meeting there (a segment passing through counts twice). Per L7 block (dataset ``street_grid``):

    intersections   connectors where three or more street ends meet
    dead_ends       connectors that end a single street (cul-de-sacs, gated or unfinished lanes, and mapping gaps)

Only public streets count: trunk, primary, secondary, tertiary, residential, unclassified, living and pedestrian
streets. Motorways are not streets people walk or turn off, and service lanes, footways and paths are mapped so
unevenly across Indian cities that counting them would measure mapping effort rather than the street grid.

    python -m pipeline.realestate.streetgrid [--region all]
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RELEASE = "2026-10-21.0"
STREETS = ("trunk", "primary", "secondary", "tertiary", "residential", "living_street", "unclassified", "pedestrian")
END = 1e-9


def degrees(segments):
    """{connector id: degree} from [(connectors)] where connectors is [{'connector_id', 'at'}]."""
    deg = {}
    for conns in segments:
        for c in conns or ():
            at = c["at"] if c.get("at") is not None else 0.0
            deg[c["connector_id"]] = deg.get(c["connector_id"], 0) + (1 if at <= END or at >= 1 - END else 2)
    return deg


def records(points, deg):
    """points: [(id, lng, lat)]; yields per-connector records for intersections and dead ends."""
    for cid, lng, lat in points:
        d = deg.get(cid, 0)
        if d >= 3:
            yield {"lat": lat, "lng": lng, "intersections": 1}
        elif d == 1:
            yield {"lat": lat, "lng": lng, "dead_ends": 1}


def fetch(region, release=RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    # The container's injected AWS keys break anonymous reads of Overture's public bucket.
    for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(k, None)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    base = f"s3://overturemaps-us-west-2/release/{release}/theme=transportation"
    box = f"bbox.xmin < {e} AND bbox.xmax > {w} AND bbox.ymin < {n} AND bbox.ymax > {s}"
    keep = ", ".join(f"'{c}'" for c in STREETS)
    segs = con.execute(f"""
        SELECT connectors FROM read_parquet('{base}/type=segment/*')
        WHERE subtype = 'road' AND class IN ({keep}) AND {box}""").fetchall()
    pts = con.execute(f"""
        SELECT id, (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2 FROM read_parquet('{base}/type=connector/*')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}""").fetchall()
    return [r[0] for r in segs], pts


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("intersections", "Street intersections (3 or more ways)", agg="sum", unit="intersections", ramp="viridis", higher_is="better"),
        FieldSpec("dead_ends", "Dead ends", agg="sum", unit="dead ends", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="street_grid", title="Street connectivity (intersections and dead ends)", level=LEVEL, fields=specs, group="Mobility",
        description=f"Intersections (three or more street ends meeting) and dead ends per block from Overture Maps transportation "
                    f"segments (release {RELEASE}, from OpenStreetMap): public streets only (trunk to residential, unclassified, living "
                    "and pedestrian streets); motorways, service lanes, footways and paths left out.",
        source="pipeline/realestate/streetgrid.py (Overture Maps transportation)",
        license="ODbL (OpenStreetMap contributors, via Overture Maps)", default_field="intersections", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for region in (CITY_PILOTS if a.region == "all" else a.region.split(",")):
        segs, pts = fetch(region)
        recs = list(records(pts, degrees(segs)))
        info = cell_dataset(region, recs)
        print(f"{region}: {len(segs)} segments, {sum('intersections' in r for r in recs)} intersections, "
              f"{sum('dead_ends' in r for r in recs)} dead ends, {info['cells']} blocks", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
