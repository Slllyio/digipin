"""Diwali night air: daily PM2.5 on Diwali and the day after against the week before, 2017-2022, from GHAP (Wei et al.,
global high-resolution air pollutants, 1 km daily PM2.5; CC BY 4.0).

Firecrackers on Diwali night stack on top of crop-fire smoke and the first cold, still nights of the winter, so the
day after Diwali is often the worst air of the year in north India. Within 8 km of the city centre (shared with
heatisland.py), the mean of Diwali and the following day is compared with days 3 to 10 before Diwali, year by year,
and one value is copied to every lived-in L7 block (dataset ``diwali_air``):

    dw_before        mean PM2.5 on days 3-10 before Diwali, all years (µg/m³)
    dw_after         mean PM2.5 on Diwali and the day after, all years (µg/m³)
    dw_jump_pct      how much higher (%), the median of the yearly jumps
    dw_worst_year    the year with the biggest jump
    dw_worst_after   PM2.5 on Diwali and the day after that year (µg/m³)
    dw_years         years with data

    python -m pipeline.realestate.diwaliair --region delhi
"""
from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path

from pipeline.realestate.heatisland import CENTRE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "projects/sat-io/open-datasets/GHAP/GHAP_D1K_PM25"
RADIUS_M = 8000
# Lakshmi Puja day (the main Diwali night)
DIWALI = {2017: "2017-10-19", 2018: "2018-11-07", 2019: "2019-10-27", 2020: "2020-11-14", 2021: "2021-11-04",
          2022: "2022-10-24"}


def summarise(yearly):
    """{year: (before, after)} in µg/m³ -> fields."""
    ok = {y: (b, a) for y, (b, a) in yearly.items() if b and a}
    if len(ok) < 3:
        return {}
    jumps = sorted((100 * (a / b - 1), y) for y, (b, a) in ok.items())
    med = jumps[len(jumps) // 2][0] if len(jumps) % 2 else (jumps[len(jumps) // 2 - 1][0] + jumps[len(jumps) // 2][0]) / 2
    worst = jumps[-1][1]
    return {"dw_before": round(sum(b for b, _ in ok.values()) / len(ok), 1), "dw_after": round(sum(a for _, a in ok.values()) / len(ok), 1),
            "dw_jump_pct": round(med, 0), "dw_worst_year": worst, "dw_worst_after": round(ok[worst][1], 0), "dw_years": len(ok)}


def fetch(region):
    from pipeline.cells import earthengine as gee
    ee = gee.init()
    geom = ee.Geometry.Point(CENTRE[region]).buffer(RADIUS_M)
    col = ee.ImageCollection(ASSET)
    band = col.first().bandNames().get(0)
    out = {}
    req = {}
    for y, d in DIWALI.items():
        day = dt.date.fromisoformat(d)
        before = col.filterDate(str(day - dt.timedelta(days=10)), str(day - dt.timedelta(days=2)))
        after = col.filterDate(str(day), str(day + dt.timedelta(days=2)))
        mean = lambda c: ee.Algorithms.If(c.size().gt(0), c.mean().reduceRegion(ee.Reducer.mean(), geom, 1000).values().get(0), None)
        req[str(y)] = ee.List([mean(before), mean(after)])
    got = ee.Dictionary(req).getInfo()
    for y, (b, a) in got.items():
        out[int(y)] = (b, a)
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    pm = lambda k, label: FieldSpec(k, label, agg="max", unit="µg/m³", ramp="reds", higher_is="worse")
    specs = [
        pm("dw_before", "PM2.5 in the week before Diwali (days 3-10 before), 2017-2022"),
        pm("dw_after", "PM2.5 on Diwali and the day after, 2017-2022"),
        FieldSpec("dw_jump_pct", "How much higher PM2.5 is on Diwali and the day after (median year)", agg="max", unit="%", ramp="reds", higher_is="worse"),
        FieldSpec("dw_worst_year", "Year with the biggest Diwali jump", agg="max", unit="year"),
        pm("dw_worst_after", "PM2.5 on Diwali and the day after, in that year"),
        FieldSpec("dw_years", "Years with data", agg="max", unit="years"),
    ]
    spec = DatasetSpec(
        id="diwali_air", title="Diwali night air (GHAP daily PM2.5, 2017-2022)", level=LEVEL, fields=specs, group="Environment",
        description="Daily 1 km PM2.5 from GHAP within 8 km of the city centre on Diwali and the day after, against days 3-10 "
                    "before, for each Diwali from 2017. One value per city.",
        source="pipeline/realestate/diwaliair.py (projects/sat-io/open-datasets/GHAP/GHAP_D1K_PM25 via Earth Engine)",
        license="CC BY 4.0 (Wei et al., GHAP)", default_field="dw_jump_pct", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    ap.add_argument("--dry", action="store_true", help="print the yearly values only")
    a = ap.parse_args(argv)
    for region in (a.region.split(",") if a.region else CENTRE):
        y = fetch(region)
        if a.dry:
            print(region, y)
            continue
        f = summarise(y)
        if not f:
            print(region, "no PM2.5 values")
            continue
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
