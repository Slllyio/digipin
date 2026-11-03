"""Rain against evaporation since the 1960s: TerraClimate monthly water balance, 1958-2024 (Abatzoglou et al.,
University of Idaho; CC0 / public domain).

The air pulls water out of lakes, soil, lawns and trees; warming should raise that pull, but across most of India
observed evaporative demand has fallen since the 1960s (haze dimming the sun and calmer winds, the "evaporation paradox"). TerraClimate gives monthly potential evapotranspiration
(what the air could evaporate), climatic water deficit (that demand minus what rain and soil can supply), precipitation and
vapour pressure deficit (how dry the air is) on a ~4 km grid. At the city centre (shared with heatisland.py), the
1961-1990 normal is compared with the latest decade, 2015-2024, and one value is copied to every lived-in L7 block
(dataset ``water_balance``):

    ta_pet_base / ta_pet_now     potential evapotranspiration, mm a year
    ta_def_base / ta_def_now     climatic water deficit, mm a year
    ta_pr_base / ta_pr_now       precipitation, mm a year
    ta_vpd_base / ta_vpd_now     mean vapour pressure deficit in March-May, kPa

    python -m pipeline.realestate.waterbalance --region delhi
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.heatisland import CENTRE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
ASSET = "IDAHO_EPSCOR/TERRACLIMATE"
BASE = range(1961, 1991)
NOW = range(2015, 2025)
SCALE = {"pet": 0.1, "def": 0.1, "pr": 1.0, "vpd": 0.01}


def summarise(monthly):
    """[(year, month, {band: raw})] -> fields; annual sums for pet/def/pr, March-May mean for vpd."""
    yr = {}
    for y, m, b in monthly:
        d = yr.setdefault(y, {"pet": 0.0, "def": 0.0, "pr": 0.0, "n": 0, "vpd": []})
        for k in ("pet", "def", "pr"):
            if b.get(k) is not None:
                d[k] += b[k] * SCALE[k]
        d["n"] += 1
        if 3 <= m <= 5 and b.get("vpd") is not None:
            d["vpd"].append(b["vpd"] * SCALE["vpd"])
    full = {y: d for y, d in yr.items() if d["n"] == 12}

    def mean(k, years):
        xs = [(sum(full[y]["vpd"]) / len(full[y]["vpd"]) if k == "vpd" else full[y][k]) for y in years if y in full and (k != "vpd" or full[y]["vpd"])]
        return xs and sum(xs) / len(xs)
    out = {}
    for k, nd in (("pet", 0), ("def", 0), ("pr", 0), ("vpd", 2)):
        a, b = mean(k, BASE), mean(k, NOW)
        if a and b:
            out[f"ta_{k}_base"], out[f"ta_{k}_now"] = round(a, nd), round(b, nd)
    return out


def fetch(region):
    import datetime as dt

    from pipeline.cells import earthengine as gee
    ee = gee.init()
    col = ee.ImageCollection(ASSET).select(["pet", "def", "pr", "vpd"]).filterDate("1961-01-01", "2025-01-01")
    pt = ee.Geometry.Point(CENTRE[region])
    rows = []
    for start, end in (("1961-01-01", "1991-01-01"), ("2015-01-01", "2025-01-01")):
        rows += col.filterDate(start, end).getRegion(pt, 4638).getInfo()[1:]
    out = []
    for r in rows:
        d = dt.datetime.fromtimestamp(r[3] / 1000, tz=dt.timezone.utc)
        out.append((d.year, d.month, dict(zip(["pet", "def", "pr", "vpd"], r[4:8]))))
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, ramp="heat": FieldSpec(k, label, agg="max", unit=unit, ramp=ramp)
    specs = [
        v("ta_pet_base", "Evaporative demand (potential evapotranspiration), 1961-1990", "mm/yr"),
        v("ta_pet_now", "Evaporative demand, 2015-2024", "mm/yr"),
        v("ta_def_base", "Climatic water deficit, 1961-1990", "mm/yr"),
        v("ta_def_now", "Climatic water deficit, 2015-2024", "mm/yr"),
        v("ta_pr_base", "Rainfall, 1961-1990", "mm/yr", "blues"),
        v("ta_pr_now", "Rainfall, 2015-2024", "mm/yr", "blues"),
        v("ta_vpd_base", "Air dryness in March-May (vapour pressure deficit), 1961-1990", "kPa"),
        v("ta_vpd_now", "Air dryness in March-May, 2015-2024", "kPa"),
    ]
    spec = DatasetSpec(
        id="water_balance", title="Rain against evaporation since the 1960s (TerraClimate, 1961-1990 vs 2015-2024)", level=LEVEL, fields=specs,
        group="Environment",
        description="Potential evapotranspiration, climatic water deficit, rainfall and March-May vapour pressure deficit at the city "
                    "centre's ~4 km TerraClimate cell, the 1961-1990 normal against 2015-2024. One value per city.",
        source="pipeline/realestate/waterbalance.py (IDAHO_EPSCOR/TERRACLIMATE via Earth Engine)",
        license="CC0 1.0 / public domain (Abatzoglou et al. 2018, Scientific Data 5:170191)", default_field="ta_def_now", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    for region in (a.region.split(",") if a.region else CENTRE):
        f = summarise(fetch(region))
        if not f:
            print(region, "no TerraClimate values")
            continue
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
