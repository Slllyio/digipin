"""Encroachment watch per block: water bodies, floodplains and tree cover lost to building.

Per L7 cell (dataset ``encroachment``), each a share of the block's land:

    water_lost_pct     surface water lost 1984–2021 (JRC Global Surface Water
                       transition: permanent or seasonal water that is gone)
    water_built_pct    … of that, built up now (Dynamic World 2025–26 built
                       class most likely)
    flood_new_pct      1-in-100-year floodplain (JRC/GloFAS) where buildings
                       appeared 2016→2023 (Open Buildings 2.5D Temporal
                       presence ≥ 0.5 in 2023, < 0.2 in 2016)
    tree_lost_pct      tree cover ≥ 30% in 2000 that was lost 2001–2024
                       (Hansen Global Forest Change)
    tree_built_pct     … of that, built up now (Dynamic World)
    recent_built_pct   built in 2025–26 (probability ≥ 0.6) but not in 2023
                       (≤ 0.3) on any of the above
                       (former water, floodplain or lost tree cover): the live
                       front of encroachment

    python -m pipeline.realestate.encroachment --region delhi
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS
from pipeline.cells import earthengine as gee
from pipeline.cells import ee_layers as el

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LOST = (3, 6)                      # GSW transition: lost permanent, lost seasonal
GFC = "UMD/hansen/global_forest_change_2025_v1_13"
DW_NOW, DW_THEN = ("2025-10-01", "2026-10-01"), ("2023-01-01", "2023-12-31")
BUILT_NOW, BUILT_THEN = 0.6, 0.3


def _dw(ee, geom, dates):
    return ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(geom).filterDate(*dates)


def _floodplain(ee, geom):
    fl = ee.ImageCollection("JRC/CEMS_GLOFAS/FloodHazard/v2_1").filterBounds(geom).mosaic()
    dry = fl.select("permanent_water_class").unmask(0).neq(1)
    return fl.select("RP100_depth").unmask(0).multiply(dry).gt(0)


def water_trees(region, log=print):
    """Lost water and tree cover, how much is built now, and building since 2023 (30 m)."""
    ee = gee.init()
    geom, bbox = el._bbox(region)
    tr = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("transition").unmask(0)
    lost = tr.eq(LOST[0]).Or(tr.eq(LOST[1]))
    gfc = ee.Image(GFC)
    tree_lost = gfc.select("treecover2000").gte(30).And(gfc.select("loss").eq(1))
    # Built now: the most likely class over the year. Built since 2023 also needs confident probabilities both
    # years, since labels flicker in dense built-up blocks.
    now = _dw(ee, geom, DW_NOW).select("label").mode().eq(6)
    recent = _dw(ee, geom, DW_NOW).select("built").mean().gte(BUILT_NOW).And(
        _dw(ee, geom, DW_THEN).select("built").mean().lte(BUILT_THEN))
    any_ = lost.Or(tree_lost).Or(_floodplain(ee, geom))
    log(f"{region}: water, trees, Dynamic World")
    return gee.fetch(gee.to_cells(ee.Image.cat([
        lost.rename("wl"), lost.And(now).rename("wb"),
        tree_lost.rename("tl"), tree_lost.And(now).rename("tb"),
        any_.And(recent).rename("rb")]).unmask(0), 30), bbox, LEVEL, tile=96)


def floodplain_new(region, log=print):
    """Share of the block that is new building (Open Buildings 2016→2023) in the 100-year floodplain (4 m)."""
    ee = gee.init()
    geom, bbox = el._bbox(region)
    col = ee.ImageCollection("GOOGLE/Research/open-buildings-temporal/v1").filterBounds(geom)

    def presence(y):
        c = col.filter(ee.Filter.calendarRange(y, y, "year"))
        return c.mosaic().setDefaultProjection(c.first().projection().atScale(4)).select("building_presence")

    new = presence(2023).gte(0.5).And(presence(2016).unmask(0).lt(0.2)).unmask(0)
    log(f"{region}: floodplain buildings")
    return gee.fetch(gee.to_cells(new.And(_floodplain(ee, geom)).rename("fn"), 4), bbox, LEVEL, tile=48)


def rows_from(a, b):
    rows = {}
    for code, x in gee.merge(a, b).items():
        if x.get("wl") is None:
            continue
        r = {"water_lost_pct": x["wl"] * 100, "water_built_pct": x["wb"] * 100,
             "tree_lost_pct": x["tl"] * 100, "tree_built_pct": x["tb"] * 100,
             "recent_built_pct": (x.get("rb") or 0) * 100, "flood_new_pct": (x.get("fn") or 0) * 100}
        r = {k: el._r(v, 2) for k, v in r.items()}
        if any(v >= 0.5 for v in r.values()):
            rows[code] = r
    return rows


def compute(region, log=print):
    rows = rows_from(water_trees(region, log), floodplain_new(region, log))
    log(f"{region}: {len(rows)} cells with any loss")
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("water_lost_pct", "Surface water lost since 1984", agg="mean", unit="% of block", domain=[0, 50],
                  ramp="reds", higher_is="worse"),
        FieldSpec("water_built_pct", "Former water now built up", agg="mean", unit="% of block", domain=[0, 30],
                  ramp="reds", higher_is="worse"),
        FieldSpec("flood_new_pct", "New buildings in the 100-year floodplain (2016→2023)", agg="mean",
                  unit="% of block", domain=[0, 10], ramp="reds", higher_is="worse"),
        FieldSpec("tree_lost_pct", "Tree cover lost 2001–2024", agg="mean", unit="% of block", domain=[0, 30],
                  ramp="reds", higher_is="worse"),
        FieldSpec("tree_built_pct", "Lost tree cover now built up", agg="mean", unit="% of block", domain=[0, 20],
                  ramp="reds", higher_is="worse"),
        FieldSpec("recent_built_pct", "Built since 2023 on former water, floodplain or lost trees", agg="mean",
                  unit="% of block", domain=[0, 10], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="encroachment", title="Encroachment watch", level=LEVEL, fields=specs, group="Real estate",
        description="Water bodies, floodplains and tree cover lost to building: JRC Global Surface Water "
                    "transitions (1984–2021), JRC/GloFAS 1-in-100-year floodplain with Open Buildings 2.5D "
                    "Temporal new buildings (2016→2023), Hansen Global Forest Change tree loss (2001–2024) and "
                    "Dynamic World built-up for 2023 and 2025–26. Satellite screens: confirm against land "
                    "records and master plan zoning before calling anything illegal.",
        source="pipeline/realestate/encroachment.py via Earth Engine (JRC/GSW1_4, JRC/CEMS_GLOFAS, "
               f"GOOGLE/Research/open-buildings-temporal/v1, {GFC}, GOOGLE/DYNAMICWORLD/V1)",
        license="CC BY 4.0 (JRC, Hansen/UMD, Open Buildings, Dynamic World)",
        default_field="water_built_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def run(region, log=print):
    rows = compute(region, log)
    return cell_dataset(region, rows) if rows else None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
