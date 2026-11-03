"""Somewhere to play within a short walk: mapped playgrounds and sports grounds from Overture Maps land use (ODbL 1.0, from
OpenStreetMap).

Play spaces are Overture base-theme land-use polygons of the recreation subtype: ``playground`` (equipped children's play
areas) and ``pitch``, ``recreation_ground``, ``track`` and ``stadium`` (sports grounds, school and colony grounds, courts).
Each polygon is reduced to its centroid. Per lived-in L7 block (dataset ``play_space``):

    pl_playground_m   straight-line distance to the nearest mapped playground (m)
    pl_ground_m       distance to the nearest playground or sports ground of any kind (m)
    pl_within_500     playgrounds and sports grounds within ``NEAR_M`` (centroids)
    pl_area_500       their total area (m2) where the polygon centroid is within ``NEAR_M``

OpenStreetMap maps playgrounds and school grounds unevenly: fuller in planned colonies and central areas, thin in
informal and fringe areas, and many school grounds are closed to the public. Read distances as "nearest mapped".

    env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY python -m pipeline.realestate.playspace --region bengaluru
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from pipeline._lib.regions import bbox_for
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NEAR_M = 500.0
PLAY = ("playground",)
GROUNDS = ("pitch", "recreation_ground", "track", "stadium")
M_PER_DEG = 111_320.0


def _m(la, lo, la2, lo2):
    return math.hypot((la - la2) * 110_570.0, (lo - lo2) * M_PER_DEG * math.cos(math.radians(la)))


class Grid:
    """Points [(lat, lng, area)] binned on a ~1 km grid for nearest and within-radius queries."""

    def __init__(self, pts, g=0.01):
        self.g, self.cells = g, {}
        for p in pts:
            self.cells.setdefault((int(p[0] // g), int(p[1] // g)), []).append(p)

    def near(self, la, lo, r_m):
        k = int(r_m / (self.g * 105_000)) + 1
        gy, gx = int(la // self.g), int(lo // self.g)
        return [p for dy in range(-k, k + 1) for dx in range(-k, k + 1) for p in self.cells.get((gy + dy, gx + dx), ())
                if _m(la, lo, p[0], p[1]) <= r_m]

    def nearest(self, la, lo, max_m=10_000):
        if not self.cells:
            return None
        r = 1000.0
        while r <= max_m:
            got = self.near(la, lo, r)
            if got:
                return min(_m(la, lo, p[0], p[1]) for p in got)
            r *= 2
        return None


def block_rows(cells, play, grounds):
    """cells [(code, lat, lng)]; play, grounds [(lat, lng, area_m2)] -> {code: fields}."""
    gp, ga = Grid(play), Grid(play + grounds)
    rows = {}
    for code, la, lo in cells:
        near = ga.near(la, lo, NEAR_M)
        row = {"pl_within_500": len(near), "pl_area_500": round(sum(p[2] for p in near))}
        d1, d2 = gp.nearest(la, lo), ga.nearest(la, lo)
        if d1 is not None:
            row["pl_playground_m"] = round(d1, -1)
        if d2 is not None:
            row["pl_ground_m"] = round(d2, -1)
        rows[code] = row
    return rows


def fetch(region, release=RELEASE):
    """(playgrounds, grounds) as [(lat, lng, area_m2)] from Overture land use in the region's bbox (plus a 1 km margin)."""
    import duckdb
    w, s, e, n = bbox_for(region)
    w, s, e, n = w - 0.01, s - 0.01, e + 0.01, n + 0.01
    lat = (s + n) / 2
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    cls = ", ".join(f"'{c}'" for c in PLAY + GROUNDS)
    got = con.execute(f"""
        SELECT class, ST_Y(ST_Centroid(geometry)), ST_X(ST_Centroid(geometry)), ST_Area(geometry)
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=land_use/*')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}
          AND subtype = 'recreation' AND class IN ({cls})
    """).fetchall()
    k = M_PER_DEG * M_PER_DEG * math.cos(math.radians(lat))
    play = [(la, lo, a * k) for c, la, lo, a in got if c in PLAY]
    grounds = [(la, lo, a * k) for c, la, lo, a in got if c in GROUNDS]
    return play, grounds


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("pl_playground_m", "Distance to the nearest mapped playground", agg="mean", unit="m", domain=[0, 2000], ramp="reds", higher_is="worse"),
        FieldSpec("pl_ground_m", "Distance to the nearest mapped playground or sports ground", agg="mean", unit="m", domain=[0, 1500], ramp="reds", higher_is="worse"),
        FieldSpec("pl_within_500", f"Playgrounds and sports grounds within {NEAR_M:.0f} m", agg="mean", unit="places", ramp="greens", higher_is="better"),
        FieldSpec("pl_area_500", f"Area of playgrounds and sports grounds within {NEAR_M:.0f} m", agg="mean", unit="m²", ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="play_space", title="Playgrounds and sports grounds within a short walk (Overture / OpenStreetMap)", level=LEVEL,
        fields=specs, group="Real estate",
        description=f"Straight-line distance from each block to the nearest mapped playground and to the nearest playground or "
                    f"sports ground (pitch, recreation ground, track, stadium), and how many lie within {NEAR_M:.0f} m, from "
                    f"Overture Maps base-theme land use (release {RELEASE}, from OpenStreetMap). Mapping is uneven and some "
                    "grounds belong to schools or clubs.",
        source="pipeline/realestate/playspace.py (Overture Maps base theme land_use, recreation subtype, via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap contributors via Overture Maps)", default_field="pl_ground_m", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        play, grounds = fetch(region)
        rows = block_rows(lived_cells(region), play, grounds)
        info = cell_dataset(region, rows)
        far = sum(1 for r in rows.values() if r.get("pl_ground_m", 9e9) > NEAR_M)
        print(f"{region}: {len(play)} playgrounds, {len(grounds)} grounds; {far}/{len(rows)} blocks over {NEAR_M:.0f} m from any; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
