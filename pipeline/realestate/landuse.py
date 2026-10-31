"""Mapped land use per block from Overture Maps: zoning-like mix, landfills, quarries and brownfield land.

Overture's base-theme land use comes from OpenStreetMap. Polygons are grouped and clipped to
each L7 block (dataset ``landuse``); every field is the share of the block in that use:

    residential_pct   residential
    industrial_pct    industrial and works
    commercial_pct    commercial and retail
    civic_pct         schools, colleges, universities, hospitals, institutional and religious
    military_pct      military land and airfields
    construction_pct  construction sites and greenfield land marked for building
    brownfield_pct    brownfield (cleared former industrial or built land)
    landfill_pct      landfills and dumps
    quarry_pct        quarries
    farm_pct          farmland, farmyards, orchards, allotments and plant nurseries
    protected_pct     national parks, sanctuaries, reserve forests and biodiversity parks (Overture 'protected')
    esz_pct           eco-sensitive zones around them (protected polygons named ESZ)
    mapped_pct        any mapped land use (all classes), a measure of how complete the mapping is

    python -m pipeline.realestate.landuse --region all
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.realestate.parks import deg2_to_m2
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
GROUPS = {
    "residential": ("residential",),
    "industrial": ("industrial", "works"),
    "commercial": ("commercial", "retail"),
    "civic": ("school", "college", "university", "education", "kindergarten", "hospital", "clinic", "institutional", "religious"),
    "military": ("military", "airfield", "training_area", "military_hospital", "military_school"),
    "construction": ("construction", "greenfield"),
    "brownfield": ("brownfield",),
    "landfill": ("landfill",),
    "quarry": ("quarry",),
    "farm": ("farmland", "farmyard", "orchard", "allotments", "plant_nursery", "greenhouse_horticulture", "vineyard"),
}
_GROUP_OF = {cls: g for g, classes in GROUPS.items() for cls in classes}
PROTECTED = ("protected", "esz")
PROTECTED_MAX_DEG2 = 0.2      # about 2,400 km² at Indian latitudes


def case_sql():
    """SQL CASE mapping an Overture land-use class to its group (NULL for the rest)."""
    whens = " ".join(f"WHEN class = '{cls}' THEN '{g}'" for cls, g in _GROUP_OF.items())
    return f"CASE {whens} ELSE NULL END"


def protected_sql():
    """SQL for a protected polygon's group: 'esz' for eco-sensitive-zone buffers, else 'protected'."""
    return "CASE WHEN names.primary ILIKE '%ESZ%' OR names.primary ILIKE '%eco%sensitive%' THEN 'esz' ELSE 'protected' END"


def fetch(region, release=RELEASE):
    """{code: {group: m², '_all': m²}} from clipping Overture land use to the L7 cells of the region."""
    import duckdb

    from pipeline.cells import store
    w, s, e, n = bbox_for(region)
    lat = (s + n) / 2
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    # Protected areas keep their own groups (eco-sensitive zones apart); polygons over PROTECTED_MAX_DEG2, such as
    # Pacific marine monuments that wrap the antimeridian, and 'aboriginal_land' (mis-tagged in India) are dropped.
    con.execute(f"""
        CREATE TABLE g AS SELECT geometry AS geom,
            CASE WHEN subtype = 'protected' THEN {protected_sql()} ELSE {case_sql()} END AS grp
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=land_use/*')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}
          AND (subtype <> 'protected' OR (class <> 'aboriginal_land' AND ST_Area(geometry) < {PROTECTED_MAX_DEG2}))
    """)
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    cells = []
    for c in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(c)
        cells.append((c, b["west"], b["south"], b["east"], b["north"]))
    con.execute("CREATE TABLE c (code VARCHAR, w DOUBLE, s DOUBLE, e DOUBLE, n DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?, ?, ?)", cells)
    out = con.execute("""
        SELECT c.code, coalesce(g.grp, '_other'), sum(ST_Area(ST_Intersection(g.geom, ST_MakeEnvelope(c.w, c.s, c.e, c.n))))
        FROM c JOIN g ON ST_Intersects(g.geom, ST_MakeEnvelope(c.w, c.s, c.e, c.n))
        GROUP BY 1, 2
    """).fetchall()
    got = {}
    for code, grp, a in out:
        if a:
            got.setdefault(code, {})[grp] = deg2_to_m2(a, lat)
    return got


def rows_for(got):
    from pipeline.cells import store
    rows = []
    for code, by in got.items():
        b = store.cell_bounds(code)
        cell = deg2_to_m2((b["east"] - b["west"]) * (b["north"] - b["south"]), (b["north"] + b["south"]) / 2)
        shares = {f"{g}_pct": by.get(g, 0) for g in (*GROUPS, *PROTECTED)} | {"mapped_pct": sum(v for k, v in by.items() if k not in PROTECTED)}
        rows.append({"digipin": code, **{k: round(min(100.0, 100 * m2 / cell), 1) for k, m2 in shares.items()}})
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    label = {"residential": "Residential", "industrial": "Industrial and works", "commercial": "Commercial and retail",
             "civic": "Schools, hospitals, institutions and religious", "military": "Military and airfields",
             "construction": "Construction and greenfield sites", "brownfield": "Brownfield land", "landfill": "Landfills and dumps",
             "quarry": "Quarries", "farm": "Farmland, orchards, allotments and nurseries"}
    worse = {"landfill", "quarry"}
    specs = [FieldSpec(f"{g}_pct", f"{label[g]} (mapped land use)", agg="mean", unit="% of block", domain=[0, 100 if g == "residential" else 50],
                       ramp="reds" if g in worse else "viridis", higher_is="worse" if g in worse else None) for g in GROUPS]
    specs.append(FieldSpec("protected_pct", "National parks, sanctuaries, reserve forests and biodiversity parks", agg="mean", unit="% of block",
                           domain=[0, 100], ramp="greens", higher_is=None))
    specs.append(FieldSpec("esz_pct", "Eco-sensitive zone around a protected area", agg="mean", unit="% of block", domain=[0, 100],
                           ramp="greens", higher_is=None))
    specs.append(FieldSpec("mapped_pct", "Block area with any mapped land use", agg="mean", unit="% of block", domain=[0, 100], ramp="viridis"))
    spec = DatasetSpec(
        id="landuse", title="Mapped land use (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"Overture Maps base-theme land use (release {RELEASE}, from OpenStreetMap), grouped into residential, industrial, "
                    "commercial, civic, military, construction, brownfield, landfill, quarry and farm, and clipped to each block. It is "
                    "mapped use, not the statutory master-plan zone, and coverage is uneven: mapped_pct shows how much of a block "
                    "has any land use drawn. Protected areas (national parks, sanctuaries, reserve forests, biodiversity parks) and their "
                    "eco-sensitive zones are separate fields; polygons larger than about 2,400 km² are dropped.",
        source="pipeline/realestate/landuse.py (Overture Maps base theme via DuckDB spatial)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="industrial_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = rows_for(fetch(r))
        km = {k: sum(x[k] for x in rows) / 100 * 0.06 for k in ("landfill_pct", "quarry_pct", "brownfield_pct")}  # rough L7 area
        print(f"{r}: {len(rows)} blocks; landfill ~{km['landfill_pct']:.1f} km², quarry ~{km['quarry_pct']:.1f} km², "
              f"brownfield ~{km['brownfield_pct']:.1f} km²")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
