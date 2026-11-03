"""Railway level crossings per block, from Overture Maps (OpenStreetMap) road and rail segments.

A level crossing is a connector shared by a mainline or suburban rail segment and a road segment (OSM joins the two
ways at a node only where they cross at grade; bridges and underpasses do not share one). Metro, tram and disused
lines are left out, as are footpaths, tracks and service roads (most shared nodes on
those are inside yards, depots, ports and sidings).

Per L7 block (dataset ``level_crossings``):

    crossings        level crossings in the block
    crossings_main   of them on a main road (trunk, primary, secondary or tertiary)
    road_rank        the busiest road class crossing there (1 residential or smaller ... 5 trunk or motorway)

    python -m pipeline.realestate.levelcrossings --region all
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NOT_RAIL = ("subway", "light_rail", "tram", "monorail", "funicular", "disused", "abandoned")
NOT_ROAD = ("service", "footway", "cycleway", "steps", "path", "pedestrian", "sidewalk", "crosswalk", "track", "bridleway")
RANK = {"motorway": 5, "trunk": 5, "primary": 4, "secondary": 3, "tertiary": 2}
MAIN_RANK = 2


def fetch(region, release=RELEASE):
    """[(lat, lng, road_rank)] for every level crossing in the region's bbox."""
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET enable_progress_bar=false;")
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=transportation"
    box = f"bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}"
    not_rail = ", ".join(f"'{c}'" for c in NOT_RAIL)
    not_road = ", ".join(f"'{c}'" for c in NOT_ROAD)
    con.execute(f"""
        CREATE TABLE seg AS SELECT subtype, class, unnest(connectors).connector_id AS cid
        FROM read_parquet('{src}/type=segment/*')
        WHERE {box} AND ((subtype = 'rail' AND coalesce(class, '') NOT IN ({not_rail}))
                         OR (subtype = 'road' AND coalesce(class, '') NOT IN ({not_road})))
    """)
    con.execute("""
        CREATE TABLE lc AS SELECT d.cid, list(DISTINCT d.class) AS classes
        FROM seg r JOIN seg d ON r.cid = d.cid AND r.subtype = 'rail' AND d.subtype = 'road' GROUP BY 1
    """)
    rows = con.execute(f"""
        SELECT ST_Y(c.geometry), ST_X(c.geometry), lc.classes
        FROM read_parquet('{src}/type=connector/*') c JOIN lc ON c.id = lc.cid WHERE {box.replace('bbox.', 'c.bbox.')}
    """).fetchall()
    return [(y, x, max((RANK.get(k or "", 1) for k in classes), default=1)) for y, x, classes in rows]


def rows_from(points):
    acc = defaultdict(lambda: {"crossings": 0, "crossings_main": 0, "road_rank": 0})
    for y, x, rank in points:
        try:
            code = digipin.encode(y, x).replace("-", "")[:LEVEL]
        except ValueError:
            continue
        a = acc[code]
        a["crossings"] += 1
        a["crossings_main"] += rank >= MAIN_RANK
        a["road_rank"] = max(a["road_rank"], rank)
    return dict(acc)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("crossings", "Railway level crossings", agg="sum", unit="crossings", ramp="reds", higher_is="worse"),
        FieldSpec("crossings_main", "Level crossings on main roads", agg="sum", unit="crossings", ramp="reds", higher_is="worse"),
        FieldSpec("road_rank", "Busiest road at a level crossing (1 local … 5 trunk)", agg="max", unit="rank", domain=[1, 5], ramp="reds",
                  higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="level_crossings", title="Railway level crossings (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"Places where a mainline or suburban railway and a road meet at grade: connectors shared by an Overture Maps "
                    f"rail segment and road segment (release {RELEASE}, OpenStreetMap). Metro, tram and disused lines, footpaths, "
                    "tracks and service roads (yards, depots, sidings) are left out; crossings where OSM has not joined the ways, and recently closed ones, may be "
                    "missed or kept.",
        source="pipeline/realestate/levelcrossings.py (Overture Maps transportation via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="crossings", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        pts = fetch(r)
        rows = rows_from(pts)
        print(f"{r}: {len(pts)} level crossings, {sum(x['crossings_main'] for x in rows.values())} on main roads")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
