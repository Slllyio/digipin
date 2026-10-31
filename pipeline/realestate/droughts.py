"""Dry and wet years since 1901 per city from SPEIbase v2.11 (CSIC, CC BY 4.0), the standardised
precipitation-evapotranspiration index.

SPEI compares each period's rainfall minus evaporative demand with the same period in other years, in standard deviations,
so it captures droughts from heat as well as from missing rain. We read the 12-month SPEI ending each December (the
calendar year) at the city centre's 0.5° cell, 1901-2024, and copy one value to every lived-in L7 block (dataset
``droughts``):

    dr_dry_early / dr_dry_late     years with SPEI-12 <= -1 (moderately dry or worse), 1901-1962 vs 1963-2024 (62 years each)
    dr_severe_years                years with SPEI-12 <= -1.5 since 1901
    dr_wet_late                    years with SPEI-12 >= +1 (wet), 1963-2024
    dr_worst_year / dr_worst_spei  the driest calendar year and its SPEI
    dr_last_dry                    the latest year with SPEI-12 <= -1
    dr_trend                       least-squares trend of SPEI-12, 1901-2024, per decade (negative = drying)

    python -m pipeline.realestate.droughts --region delhi
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.heatisland import CENTRE, slope_per_decade

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "CSIC/SPEI/2_11"
SPLIT = 1963


def summarise(series):
    """{year: SPEI-12 in December} -> fields."""
    s = {y: v for y, v in series.items() if v is not None}
    if len(s) < 60:
        return {}
    early = [y for y in s if y < SPLIT]
    late = [y for y in s if y >= SPLIT]
    dry = [y for y in s if s[y] <= -1]
    worst = min(s, key=s.get)
    return {
        "dr_dry_early": sum(s[y] <= -1 for y in early), "dr_dry_late": sum(s[y] <= -1 for y in late),
        "dr_severe_years": sum(v <= -1.5 for v in s.values()), "dr_wet_late": sum(s[y] >= 1 for y in late),
        "dr_worst_year": worst, "dr_worst_spei": round(s[worst], 2), "dr_last_dry": max(dry) if dry else None,
        "dr_trend": round(slope_per_decade(s), 3),
    }


def fetch(region):
    from pipeline.cells import earthengine as gee
    ee = gee.init()
    col = ee.ImageCollection(ASSET).select("SPEI_12_month").filter(ee.Filter.calendarRange(12, 12, "month"))
    rows = col.getRegion(ee.Geometry.Point(CENTRE[region]), 55000).getInfo()
    head, out = rows[0], {}
    it, iv = head.index("time"), head.index("SPEI_12_month")
    import datetime as dt
    for r in rows[1:]:
        if r[iv] is not None:
            out[dt.datetime.fromtimestamp(r[it] / 1000, tz=dt.timezone.utc).year] = float(r[iv])
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, hi=None: FieldSpec(k, label, agg="max", unit=unit, ramp="heat", higher_is=hi)
    specs = [
        v("dr_dry_early", f"Dry years (SPEI-12 at or below -1), 1901-{SPLIT - 1}", "years", "worse"),
        v("dr_dry_late", f"Dry years (SPEI-12 at or below -1), {SPLIT}-2024", "years", "worse"),
        v("dr_severe_years", "Severely dry years (SPEI-12 at or below -1.5) since 1901", "years", "worse"),
        v("dr_wet_late", f"Wet years (SPEI-12 at or above +1), {SPLIT}-2024", "years"),
        v("dr_worst_year", "Driest calendar year since 1901", "year"),
        v("dr_worst_spei", "SPEI-12 of the driest year", "SD", "better"),
        v("dr_last_dry", "Latest dry year", "year"),
        v("dr_trend", "Trend in SPEI-12, 1901-2024 (negative = drying)", "SD/decade", "better"),
    ]
    spec = DatasetSpec(
        id="droughts", title="Dry and wet years since 1901 (SPEIbase v2.11)", level=LEVEL, fields=specs, group="Environment",
        description="Calendar-year (12-month, ending December) standardised precipitation-evapotranspiration index at the city "
                    "centre's 0.5° cell, 1901-2024, from SPEIbase v2.11 (CRU TS 4.08). One value per city.",
        source="pipeline/realestate/droughts.py (CSIC/SPEI/2_11 via Earth Engine)",
        license="CC BY 4.0 (Beguería, Vicente-Serrano et al., SPEIbase v2.11, CSIC, digital.csic.es)",
        default_field="dr_dry_late", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    rec = {k: x for k, x in fig.items() if x is not None}
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **rec} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    for region in (a.region.split(",") if a.region else CENTRE):
        f = summarise(fetch(region))
        if not f:
            print(region, "no SPEI values")
            continue
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
