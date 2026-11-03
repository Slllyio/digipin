"""The region's total water store from space, 2002-2024: NASA JPL GRACE and GRACE-FO mascons (RL06.3 v04, with the
coastline resolution improvement; NASA open data, no restrictions).

The twin GRACE satellites weigh the water held in and on the ground (groundwater, soil moisture, lakes and reservoirs)
from tiny changes in gravity. Mascons are about 300 km across, so this is the regional store a city sits in and draws on,
not the aquifer under one block. At the city centre (shared with heatisland.py), annual means of the water-equivalent
thickness are taken for years with at least 6 months of data (there is a gap between the missions, mid-2017 to mid-2018),
and one value is copied to every lived-in L7 block (dataset ``water_store``):

    ws_trend_cm_yr      least-squares trend 2003-2023, cm of water a year (negative = the region is losing water)
    ws_change_cm        mean of 2019-2023 minus mean of 2003-2007, cm of water
    ws_low_year         the year with the lowest store
    ws_last_cm          the latest full year's anomaly against the 2004-2009 baseline, cm

    python -m pipeline.realestate.waterstore --region delhi
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.heatisland import CENTRE, mean_of, slope_per_decade

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "NASA/GRACE/MASS_GRIDS_V04/MASCON_CRI"
YEARS = range(2003, 2024)


def annual(monthly):
    """[(year, month, cm)] -> {year: mean cm} for years with at least 6 months."""
    acc = {}
    for y, _, v in monthly:
        if v is not None:
            acc.setdefault(y, []).append(v)
    return {y: sum(v) / len(v) for y, v in acc.items() if len(v) >= 6}


def summarise(yearly):
    s = {y: v for y, v in yearly.items() if y in YEARS}
    if len(s) < 15:
        return {}
    tr = slope_per_decade(s)
    a, b = mean_of(s, range(2003, 2008)), mean_of(s, range(2019, 2024))
    last = max(s)
    return {"ws_trend_cm_yr": round(tr / 10, 2), "ws_change_cm": None if a is None or b is None else round(b - a, 1),
            "ws_low_year": min(s, key=s.get), "ws_last_cm": round(s[last], 1)}


def fetch(region):
    import datetime as dt

    from pipeline.cells import earthengine as gee
    ee = gee.init()
    rows = ee.ImageCollection(ASSET).select("lwe_thickness").getRegion(ee.Geometry.Point(CENTRE[region]), 55000).getInfo()
    head = rows[0]
    it, iv = head.index("time"), head.index("lwe_thickness")
    out = []
    for r in rows[1:]:
        d = dt.datetime.fromtimestamp(r[it] / 1000, tz=dt.timezone.utc)
        out.append((d.year, d.month, r[iv]))
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    specs = [
        FieldSpec("ws_trend_cm_yr", "Trend in the region's total water store, 2003-2023", agg="max", unit="cm of water/yr", ramp="diverging", higher_is="better"),
        FieldSpec("ws_change_cm", "Water store 2019-2023 minus 2003-2007", agg="max", unit="cm of water", ramp="diverging", higher_is="better"),
        FieldSpec("ws_low_year", "Year with the lowest water store", agg="max", unit="year"),
        FieldSpec("ws_last_cm", "Latest year's store against the 2004-2009 baseline", agg="max", unit="cm of water", ramp="diverging", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="water_store", title="The region's total water store from space (NASA GRACE/GRACE-FO, 2002-2024)", level=LEVEL,
        fields=specs, group="Environment",
        description="Water held in and on the ground (groundwater, soil moisture, lakes and reservoirs) in the ~300 km mascon around "
                    "the city centre, from NASA JPL GRACE and GRACE-FO RL06.3 v04 CRI mascons. One value per city.",
        source="pipeline/realestate/waterstore.py (NASA/GRACE/MASS_GRIDS_V04/MASCON_CRI via Earth Engine)",
        license="NASA open data (no restrictions; cite Watkins et al. 2015, Wiese et al. 2016)", default_field="ws_trend_cm_yr", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    rec = {k: x for k, x in fig.items() if x is not None}
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **rec} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    for region in (a.region.split(",") if a.region else CENTRE):
        f = summarise(annual(fetch(region)))
        if not f:
            print(region, "no GRACE values")
            continue
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
