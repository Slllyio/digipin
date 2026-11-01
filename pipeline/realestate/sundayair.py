"""How much of the city's NO2 comes from the working week: Sentinel-5P TROPOMI tropospheric NO2 on Sundays against
working days, and the spring 2020 lockdown against the same weeks of 2019 and 2021-2023 (Copernicus Sentinel data, free and
open; contains modified Copernicus Sentinel data).

NO2 lives only hours, so a column that drops on Sundays and in a lockdown is mostly traffic, offices and industry that
stop; what remains is power plants, brick kilns, burning and background. Within 8 km of the city centre (shared with
heatisland.py), daily OFFL L3 columns are averaged; one value is copied to every lived-in L7 block (dataset ``sunday_air``):

    sa_weekday       mean tropospheric NO2 on Monday-Saturday, 2019-2024 (µmol/m²)
    sa_sunday        mean on Sundays, 2019-2024 (µmol/m²)
    sa_sunday_drop   1 - Sunday / weekday (%)
    sa_lockdown_drop 1 - (25 Mar - 30 Apr 2020) / (same dates, 2019 and 2021-2023) (%)

    python -m pipeline.realestate.sundayair --region delhi
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.heatisland import CENTRE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "COPERNICUS/S5P/OFFL/L3_NO2"
BAND = "tropospheric_NO2_column_number_density"
RADIUS_M = 8000


def summarise(weekday, sunday, lock, normal):
    """Means in mol/m² -> fields in µmol/m² and %."""
    if not weekday or not sunday:
        return {}
    f = {"sa_weekday": round(weekday * 1e6, 1), "sa_sunday": round(sunday * 1e6, 1),
         "sa_sunday_drop": round(100 * (1 - sunday / weekday), 1)}
    if lock and normal:
        f["sa_lockdown_drop"] = round(100 * (1 - lock / normal), 1)
    return f


def fetch(region):
    from pipeline.cells import earthengine as gee
    ee = gee.init()
    geom = ee.Geometry.Point(CENTRE[region]).buffer(RADIUS_M)
    col = ee.ImageCollection(ASSET).select(BAND)

    def mean_of(c):
        v = c.mean().reduceRegion(ee.Reducer.mean(), geom, 1113).get(BAND)
        return v

    base = col.filterDate("2019-01-01", "2025-01-01")
    sunday = base.map(lambda i: i.set("dow", ee.Date(i.get("system:time_start")).getRelative("day", "week")))
    wk = mean_of(sunday.filter(ee.Filter.neq("dow", 6)))  # getRelative day-of-week: Monday = 0, Sunday = 6
    su = mean_of(sunday.filter(ee.Filter.eq("dow", 6)))
    spring = lambda y: col.filterDate(f"{y}-03-25", f"{y}-05-01")
    lock = mean_of(spring(2020))
    normal = mean_of(spring(2019).merge(spring(2021)).merge(spring(2022)).merge(spring(2023)))
    vals = ee.Dictionary({"wk": wk, "su": su, "lock": lock, "normal": normal}).getInfo()
    return vals


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    specs = [
        FieldSpec("sa_weekday", "NO2 on working days (Mon-Sat), 2019-2024", agg="max", unit="µmol/m²", ramp="heat", higher_is="worse"),
        FieldSpec("sa_sunday", "NO2 on Sundays, 2019-2024", agg="max", unit="µmol/m²", ramp="heat", higher_is="worse"),
        FieldSpec("sa_sunday_drop", "How much lower NO2 is on Sundays", agg="max", unit="%", ramp="viridis"),
        FieldSpec("sa_lockdown_drop", "How much lower NO2 was in the 2020 lockdown (25 Mar-30 Apr)", agg="max", unit="%", ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="sunday_air", title="Sunday and lockdown NO2 (Sentinel-5P TROPOMI, 2019-2024)", level=LEVEL, fields=specs,
        group="Environment",
        description="Tropospheric NO2 within 8 km of the city centre on Sundays against working days (2019-2024), and in the spring "
                    "2020 lockdown against the same dates in 2019 and 2021-2023, from Sentinel-5P OFFL L3. One value per city.",
        source="pipeline/realestate/sundayair.py (COPERNICUS/S5P/OFFL/L3_NO2 via Earth Engine)",
        license="Copernicus Sentinel data (free, full and open; contains modified Copernicus Sentinel data 2019-2024)",
        default_field="sa_sunday_drop", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    for region in (a.region.split(",") if a.region else CENTRE):
        v = fetch(region)
        f = summarise(v.get("wk"), v.get("su"), v.get("lock"), v.get("normal"))
        if not f:
            print(region, "no NO2 values")
            continue
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
