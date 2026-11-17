"""Map quality per block: where buildings and streets come from and how fully they are tagged (Overture Maps, ODbL).

urbanity (Yap et al. 2023, MIT) checks OpenStreetMap attribute completeness before trusting a city's graph (share of
buildings with height, with levels, etc.). DigiPin's lenses lean on the same open maps, so this bakes that check per L7
block (dataset ``map_quality``) from Overture's per-feature source records:

    mq_buildings      building footprints (all sources)
    mq_osm_pct        footprints drawn by OpenStreetMap mappers (the rest are Google / Microsoft ML footprints)
    mq_height_pct     footprints carrying a height or number of floors
    mq_type_pct       footprints with a building type (class or subtype, e.g. residential, commercial, school)
    mq_street_km      public street length (trunk to residential, unclassified, living, pedestrian)
    mq_named_pct      share of that street length with a name

    python -m pipeline.realestate.mapquality [--region all]
"""
from __future__ import annotations

import argparse
import math
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RELEASE = "2026-10-21.0"
STREETS = ("trunk", "primary", "secondary", "tertiary", "residential", "living_street", "unclassified", "pedestrian")


def _con():
    import duckdb
    for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(k, None)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET geometry_always_xy = true;")
    return con


def building_rows(con, bbox, release=RELEASE):
    w, s, e, n = bbox
    base = f"s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*"
    return con.execute(f"""
        SELECT (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2,
               list_contains([x.dataset for x in sources], 'OpenStreetMap') AS osm,
               (height IS NOT NULL OR num_floors IS NOT NULL) AS h,
               (class IS NOT NULL OR subtype IS NOT NULL) AS t
        FROM read_parquet('{base}')
        WHERE bbox.xmin < {e} AND bbox.xmax > {w} AND bbox.ymin < {n} AND bbox.ymax > {s}""").fetchall()


def street_rows(con, bbox, release=RELEASE):
    w, s, e, n = bbox
    base = f"s3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*"
    keep = ", ".join(f"'{c}'" for c in STREETS)
    return con.execute(f"""
        SELECT (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2,
               ST_Length_Spheroid(geometry) AS m,
               (names.primary IS NOT NULL AND length(trim(names.primary)) > 0) AS named
        FROM read_parquet('{base}')
        WHERE subtype = 'road' AND class IN ({keep})
          AND bbox.xmin < {e} AND bbox.xmax > {w} AND bbox.ymin < {n} AND bbox.ymax > {s}""").fetchall()


def aggregate(buildings, streets, code_of):
    """Per-block records from building (x, y, osm, h, t) and street (x, y, metres, named) rows. Pure given code_of."""
    acc = {}
    for x, y, osm, h, t in buildings:
        c = code_of(y, x)
        if not c:
            continue
        a = acc.setdefault(c, [0, 0, 0, 0, 0.0, 0.0])
        a[0] += 1
        a[1] += bool(osm)
        a[2] += bool(h)
        a[3] += bool(t)
    for x, y, m, named in streets:
        c = code_of(y, x)
        if not c or m is None or not math.isfinite(m):
            continue
        a = acc.setdefault(c, [0, 0, 0, 0, 0.0, 0.0])
        a[4] += m
        a[5] += m if named else 0.0
    out = []
    for c, (nb, osm, h, t, sm, nm) in sorted(acc.items()):
        r = {"digipin": c, "mq_buildings": nb}
        if nb:
            r.update(mq_osm_pct=100 * osm / nb, mq_height_pct=100 * h / nb, mq_type_pct=100 * t / nb)
        if sm > 0:
            r.update(mq_street_km=sm / 1000, mq_named_pct=100 * nm / sm)
        out.append(r)
    return out


FIELDS = [
    ("mq_buildings", "Building footprints mapped", "sum", "buildings", "viridis", None),
    ("mq_osm_pct", "Footprints drawn by OpenStreetMap mappers", "mean", "%", "viridis", "better"),
    ("mq_height_pct", "Footprints with height or floors", "mean", "%", "viridis", "better"),
    ("mq_type_pct", "Footprints with a building type", "mean", "%", "viridis", "better"),
    ("mq_street_km", "Public street length", "sum", "km", "viridis", None),
    ("mq_named_pct", "Street length with a name", "mean", "%", "viridis", "better"),
]


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec(k, label, agg=agg, unit=unit, ramp=ramp, higher_is=hi) for k, label, agg, unit, ramp, hi in FIELDS]
    spec = DatasetSpec(
        id="map_quality", title="Map quality (sources and tag completeness)", level=LEVEL, fields=specs, group="Data quality",
        description=f"Where each block's buildings and streets come from and how fully they are tagged, from Overture Maps "
                    f"(release {RELEASE}): share of footprints drawn in OpenStreetMap (the rest are Google Open Buildings or "
                    "Microsoft ML footprints), shares carrying height/floors and a building type, public street length and "
                    "the share of it with a name. After urbanity's OSM completeness checks (Yap et al. 2023).",
        source="pipeline/realestate/mapquality.py (Overture Maps buildings and transportation)",
        license="ODbL (OpenStreetMap contributors via Overture Maps)", default_field="mq_osm_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS, bbox_for
    from pipeline.cells.store import cell_code
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    con = _con()
    code_of = lambda lat, lng: cell_code(LEVEL, float(lat), float(lng))  # noqa: E731
    for region in (CITY_PILOTS if a.region == "all" else a.region.split(",")):
        bbox = bbox_for(region)
        w, s, e, n = bbox
        inside = lambda r: w <= r[0] <= e and s <= r[1] <= n  # noqa: E731
        b = [r for r in building_rows(con, bbox) if inside(r)]
        st = [r for r in street_rows(con, bbox) if inside(r)]
        info = cell_dataset(region, aggregate(b, st, code_of))
        print(f"{region}: {len(b)} buildings, {len(st)} streets, {info['cells']} blocks", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
