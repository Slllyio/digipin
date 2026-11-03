"""Airport runways and the land under their flight paths, per block.

Runways come from Overture Maps base infrastructure (class ``runway``, from
OpenStreetMap). Segments are merged into whole runways and those of at least
MIN_RUNWAY_M are kept (jet runways). Per L7 block (dataset ``flight_paths``):

    runway_km       distance to the nearest jet runway
    under_path      1 inside an approach or departure corridor: beyond a runway end, within
                    PATH_KM along the extended centreline, and within HALF_W_KM + PATH_SPREAD × the
                    distance out to either side
    path_km         for blocks under a path, distance from the runway end along the centreline

Aircraft below about 1,000 m are under 10 km out on a 3° glide slope, which is where
noise and low overflights are worst.

    python -m pipeline.realestate.flightpaths --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
MIN_RUNWAY_M = 2000
PATH_KM = 10.0
HALF_W_KM = 0.5
PATH_SPREAD = 0.1
KM_LAT = 110.574


def _xy(lng, lat, lat0):
    """Local km coordinates around latitude ``lat0``."""
    return lng * 111.320 * math.cos(math.radians(lat0)), lat * KM_LAT


def corridor(px, py, ax, ay, bx, by):
    """(distance to the runway segment km, km out along the extended centreline or None) for point P."""
    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    t = (px - ax) * ux + (py - ay) * uy                 # along-track from A
    cross = abs(-(px - ax) * uy + (py - ay) * ux)        # cross-track
    if t < 0:
        out = -t
    elif t > length:
        out = t - length
    else:
        out = 0.0
    dist = math.hypot(out, cross)
    if 0 < out <= PATH_KM and cross <= HALF_W_KM + PATH_SPREAD * out:
        return dist, out
    return dist, None


def runways(region, release=RELEASE):
    """[(lng_a, lat_a, lng_b, lat_b, length_m)] for merged jet runways near the region."""
    import duckdb
    w, s, e, n = bbox_for(region)
    pad = 0.15
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    rows = con.execute(f"""
        WITH r AS (
            SELECT geometry AS g FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=infrastructure/*')
            WHERE class = 'runway' AND bbox.xmin BETWEEN {w - pad} AND {e + pad} AND bbox.ymin BETWEEN {s - pad} AND {n + pad}
              AND ST_GeometryType(geometry) = 'LINESTRING'
        ), m AS (SELECT UNNEST(ST_Dump(ST_LineMerge(ST_Union_Agg(g)))) AS d FROM r)
        SELECT ST_X(ST_StartPoint(d.geom)), ST_Y(ST_StartPoint(d.geom)), ST_X(ST_EndPoint(d.geom)), ST_Y(ST_EndPoint(d.geom)) FROM m
    """).fetchall()
    out = []
    for xa, ya, xb, yb in rows:
        lat0 = (ya + yb) / 2
        ax, ay = _xy(xa, ya, lat0)
        bx, by = _xy(xb, yb, lat0)
        length = math.hypot(bx - ax, by - ay) * 1000
        if length >= MIN_RUNWAY_M:
            out.append((xa, ya, xb, yb, length))
    return out


def rows_for(region, rws):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    lat0 = sum(bbox_for(region)[1::2]) / 2
    segs = [(*_xy(xa, ya, lat0), *_xy(xb, yb, lat0)) for xa, ya, xb, yb, _ in rws]
    rows = []
    for code in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(code)
        px, py = _xy((b["west"] + b["east"]) / 2, (b["south"] + b["north"]) / 2, lat0)
        best, path = None, None
        for s in segs:
            d, out = corridor(px, py, *s)
            best = d if best is None else min(best, d)
            if out is not None:
                path = out if path is None else min(path, out)
        if best is None or best > 30:
            continue
        rows.append({"digipin": code, "runway_km": round(best, 2), "under_path": int(path is not None),
                     "path_km": round(path, 2) if path is not None else None})
    return rows


def cell_dataset(region, rows, rws):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("runway_km", "Distance to the nearest jet runway", agg="min", unit="km", domain=[0, 20], ramp="viridis", higher_is="better"),
        FieldSpec("under_path", f"Under an approach or departure path (within {PATH_KM:.0f} km of a runway end)", agg="max", unit="yes/no",
                  domain=[0, 1], ramp="reds", higher_is="worse"),
        FieldSpec("path_km", "Distance out from the runway end along the flight path", agg="min", unit="km", domain=[0, PATH_KM],
                  ramp="heat", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="flight_paths", title="Runways and flight paths", level=LEVEL, fields=specs, group="Real estate",
        description=f"Overture Maps (OpenStreetMap) runways of {MIN_RUNWAY_M} m or more ({len(rws)} near this city), merged from segments. "
                    f"A block is under a flight path when it lies beyond a runway end, within {PATH_KM:.0f} km along the extended "
                    f"centreline and within {HALF_W_KM} km + {PATH_SPREAD:.0%} of the distance out to either side. Real tracks "
                    "turn after take-off and vary with wind and procedure, and traffic volumes are not included, so this marks "
                    "where low overflights are likely, not measured noise.",
        source="pipeline/realestate/flightpaths.py (Overture Maps base infrastructure via DuckDB spatial)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="under_path", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rws = runways(r)
        rows = rows_for(r, rws) if rws else []
        print(f"{r}: {len(rws)} jet runways, {sum(x['under_path'] for x in rows)} blocks under a flight path")
        if rows:
            cell_dataset(r, rows, rws)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
