"""Street-level public infrastructure per block from Overture Maps (OpenStreetMap points).

Overture's base-theme infrastructure is counted per L7 block (dataset ``street_infra``):

    toilets         public toilets
    drinking_water  drinking-water points and taps
    hydrants        fire hydrants
    gates           gates and lift barriers across streets and entrances (gated colonies close these)
    benches         benches
    bins            waste baskets and public bins
    atms            ATMs mapped as street objects
    telecom_towers  communication and mobile towers

Coverage follows how much mappers have walked a street, so a zero is often "not mapped", not "absent".

    python -m pipeline.realestate.streetinfra --region all
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.realestate.places import RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
KINDS = {
    "toilets": ("toilets",),
    "drinking_water": ("drinking_water",),
    "hydrants": ("fire_hydrant",),
    "gates": ("gate", "lift_gate", "swing_gate", "sliding_gate"),
    "benches": ("bench",),
    "bins": ("waste_basket", "waste_disposal"),
    "atms": ("atm",),
    "telecom_towers": ("communication_tower", "mobile_phone_tower"),
}
_KIND_OF = {cls: k for k, classes in KINDS.items() for cls in classes}


def fetch(region, release=RELEASE):
    """[(kind, lat, lng)] for the KINDS classes in the region's box."""
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET enable_progress_bar=false;")
    classes = ", ".join(f"'{c}'" for c in _KIND_OF)
    rows = con.execute(f"""
        SELECT class, ST_Y(ST_Centroid(geometry)), ST_X(ST_Centroid(geometry))
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=base/type=infrastructure/*')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n} AND class IN ({classes})
    """).fetchall()
    return [(_KIND_OF[c], lat, lng) for c, lat, lng in rows]


def rows_for(points):
    from pipeline.cells import store
    counts = {}
    for kind, lat, lng in points:
        code = store.cell_code(LEVEL, lat, lng)
        if code:
            counts.setdefault(code, dict.fromkeys(KINDS, 0))[kind] += 1
    return [{"digipin": code, **c} for code, c in counts.items()]


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    label = {"toilets": "Public toilets", "drinking_water": "Drinking-water points", "hydrants": "Fire hydrants",
             "gates": "Gates and barriers across streets", "benches": "Benches", "bins": "Public bins",
             "atms": "ATMs (street objects)", "telecom_towers": "Telecom towers"}
    specs = [FieldSpec(k, f"{label[k]} mapped in the block", agg="sum", unit="count", domain=[0, 5], ramp="viridis", higher_is=None) for k in KINDS]
    spec = DatasetSpec(
        id="street_infra", title="Street infrastructure (Overture)", level=LEVEL, fields=specs, group="Real estate",
        description=f"OpenStreetMap street objects via Overture Maps (release {RELEASE}, base infrastructure): public toilets, "
                    "drinking water, fire hydrants, gates and lift barriers, benches, bins, ATMs and telecom towers, counted per "
                    "block. Mapping is patchy, so a zero often means not yet mapped.",
        source="pipeline/realestate/streetinfra.py (Overture Maps base infrastructure via DuckDB)",
        license="ODbL 1.0 (OpenStreetMap via Overture Maps)", default_field="toilets", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        pts = fetch(r)
        rows = rows_for(pts)
        k = {kind: sum(1 for p_ in pts if p_[0] == kind) for kind in KINDS}
        print(f"{r}: {len(rows)} blocks; " + ", ".join(f"{v} {kind}" for kind, v in k.items()))
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
