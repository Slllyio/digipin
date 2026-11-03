"""Neighbourhood names per block from Overture Maps divisions (OpenStreetMap colonies, sectors, villages and wards).

Per L7 block (dataset ``neighbourhoods``):

    place       the smallest named area holding the block centre (Overture division areas: microhood, neighbourhood,
                macrohood or locality, as OSM maps colonies, sectors, urban villages and wards); where no area holds it,
                the nearest named division point within POINT_KM (also where the holding area is over BIG_KM2, a whole
                ward or town, and a named point lies within reach)
    area        the next larger named area holding it, with a different name (Dwarka around "Sector 11")
    place_src   'area' or 'point'
    district    the county-level division holding the block (a revenue district), where mapped
    pin         the postal PIN code most of the places around the block carry (Overture places' addresses, a
                distance-weighted vote within PIN_KM; codes seen fewer than PIN_MIN times in the city are dropped as typos)
    pin_share   that code's share of the vote (%): low values sit on a PIN boundary

    python -m pipeline.realestate.neighbourhoods --region all

Overture reads public S3 anonymously; in a container whose AWS_* variables hold placeholder credentials, run with
`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY`.
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
SMALL = ("microhood", "neighborhood", "macrohood", "locality")
POINT_KM = 1.5
BIG_KM2 = 12                    # an area this large (a whole ward or town) yields to a named point inside it
PIN_KM = 0.6
PIN_BIN = 0.002                 # degrees (~200 m) for binning place addresses
PIN_MIN = 10
PIN_RE = r'^[1-9][0-9]{5}$'


def lived_cells(region):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    out = []
    for c in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(c)
        out.append((c, (b["south"] + b["north"]) / 2, (b["west"] + b["east"]) / 2))
    return out


def nearest(cells, points, reach_km=POINT_KM):
    """{code: name} of the nearest point within reach_km, via a 0.02° bucket grid. points: [(lat, lng, name)]."""
    step = 0.02
    grid = {}
    for y, x, name in points:
        grid.setdefault((int(y // step), int(x // step)), []).append((y, x, name))
    out = {}
    for code, y, x in cells:
        kx = math.cos(math.radians(y))
        best, bd = None, reach_km
        gy, gx = int(y // step), int(x // step)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for py, px, name in grid.get((gy + dy, gx + dx), ()):
                    d = math.hypot((py - y) * 110.57, (px - x) * 111.32 * kx)
                    if d <= bd:
                        best, bd = name, d
        if best:
            out[code] = best
    return out


def pin_vote(cells, bins, reach_km=PIN_KM, step=PIN_BIN):
    """{code: (pin, share%)} from bins {(iy, ix): {pin: count}} of place addresses, weighting each bin by 1 / (d + 0.1 km)."""
    out = {}
    r = math.ceil(reach_km / (step * 105)) + 1
    for code, y, x in cells:
        kx = math.cos(math.radians(y))
        gy, gx = math.floor(y / step), math.floor(x / step)
        votes = {}
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                b = bins.get((gy + dy, gx + dx))
                if not b:
                    continue
                d = math.hypot((gy + dy + 0.5) * step - y, ((gx + dx + 0.5) * step - x) * kx) * 110.6
                if d > reach_km:
                    continue
                for pin, n in b.items():
                    votes[pin] = votes.get(pin, 0) + n / (d + 0.1)
        if votes:
            pin, v = max(votes.items(), key=lambda kv: kv[1])
            out[code] = (pin, round(100 * v / sum(votes.values())))
    return out


def fetch_pins(con, release, box):
    """{(iy, ix): {pin: count}} of Overture place addresses, keeping codes seen at least PIN_MIN times."""
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
    rows = con.execute(f"""
        SELECT floor(ST_Y(geometry) / {PIN_BIN})::INT, floor(ST_X(geometry) / {PIN_BIN})::INT, addresses[1].postcode AS p, count(*)
        FROM read_parquet('{src}') WHERE {box.replace(" AND country = 'IN'", "")} AND regexp_matches(addresses[1].postcode, '{PIN_RE}')
        GROUP BY 1, 2, 3""").fetchall()
    tot = {}
    for _, _, p, n in rows:
        tot[p] = tot.get(p, 0) + n
    bins = {}
    for iy, ix, p, n in rows:
        if tot[p] >= PIN_MIN:
            bins.setdefault((iy, ix), {})[p] = n
    return bins


def fetch(region, release=RELEASE):
    """{code: {'place', 'place_src', 'district'}} for the lived-in blocks of a region."""
    import duckdb
    w, s, e, n = bbox_for(region)
    cells = lived_cells(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET enable_progress_bar=false;")
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=divisions"
    box = f"bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n} AND country = 'IN'"
    small = ", ".join(f"'{x}'" for x in SMALL)
    con.execute(f"""CREATE TABLE a AS SELECT subtype, names.primary AS name, geometry AS geom, ST_Area(geometry) AS area
                    FROM read_parquet('{src}/type=division_area/*') WHERE {box} AND subtype IN ({small}, 'county') AND names.primary IS NOT NULL""")
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", cells)
    hits = con.execute("""
        SELECT c.code, a.subtype, a.name, a.area FROM c JOIN a ON ST_Contains(a.geom, ST_Point(c.x, c.y))
    """).fetchall()
    place, parent, district, inside = {}, {}, {}, {}
    for code, sub, name, area in hits:
        if sub == "county":
            if code not in district or area < district[code][1]:
                district[code] = (name, area)
        else:
            inside.setdefault(code, []).append((area, name))
    for code, areas in inside.items():
        areas.sort()
        place[code] = (areas[0][1], areas[0][0])
        up = next((nm for ar, nm in areas[1:] if nm != areas[0][1] and ar >= 2 * areas[0][0]), None)
        if up:
            parent[code] = up
    pts = con.execute(f"""SELECT ST_Y(geometry), ST_X(geometry), names.primary FROM read_parquet('{src}/type=division/*')
                          WHERE {box} AND subtype IN ({small}) AND names.primary IS NOT NULL""").fetchall()
    lat0 = (s + n) / 2
    km2 = 110.57 * 111.32 * math.cos(math.radians(lat0))
    big = {c for c, (_, ar) in place.items() if ar * km2 > BIG_KM2}
    near = nearest([c for c in cells if c[0] not in place or c[0] in big], pts)
    pins = pin_vote(cells, fetch_pins(con, release, box))
    rows = {}
    for code, _, _ in cells:
        row = {}
        if code in big and code in near and near[code] != place[code][0]:
            row = {"place": near[code], "place_src": "point", "area": place[code][0]}
        elif code in place:
            row = {"place": place[code][0], "place_src": "area"}
            if code in parent:
                row["area"] = parent[code]
        elif code in near:
            row = {"place": near[code], "place_src": "point"}
        if code in district:
            row["district"] = district[code][0]
        if code in pins:
            row["pin"], row["pin_share"] = pins[code]
        if row:
            rows[code] = row
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("place", "Neighbourhood (colony, sector, village or ward)", type="category", agg="mode"),
        FieldSpec("area", "Larger named area around it (e.g. Dwarka for Sector 11)", type="category", agg="mode"),
        FieldSpec("place_src", "Name from a mapped area or the nearest named point", type="category", agg="mode"),
        FieldSpec("district", "District", type="category", agg="mode"),
        FieldSpec("pin", "PIN code (from addresses of nearby places)", type="category", agg="mode"),
        FieldSpec("pin_share", "Share of nearby addresses with that PIN code", agg="min", unit="%", domain=[0, 100], ramp="blues",
                  higher_is="better"),
    ]
    spec = DatasetSpec(
        id="neighbourhoods", title="Neighbourhood names (Overture divisions)", level=LEVEL, fields=specs, group="Real estate",
        description=f"Names of the colonies, sectors, urban villages and wards that OpenStreetMap maps, via Overture Maps divisions "
                    f"(release {RELEASE}): the smallest named area holding each block's centre, else the nearest named place point "
                    f"within {POINT_KM} km, the district, and the PIN code most addresses of Overture places within {PIN_KM} km carry. Boundaries are crowd-mapped and uneven: names, not legal limits.",
        source="pipeline/realestate/neighbourhoods.py (Overture Maps divisions via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps); PIN codes: CDLA Permissive 2.0 (Overture places)", default_field="place", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = fetch(r)
        named = [x for x in rows.values() if "place" in x]
        areas = sum(1 for x in named if x["place_src"] == "area")
        pins = {x["pin"] for x in rows.values() if "pin" in x}
        print(f"{r}: {len(named)} blocks named ({areas} from areas), {len({x['place'] for x in named})} names, "
              f"{sum(1 for x in rows.values() if 'pin' in x)} with a PIN code ({len(pins)} codes)")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
