#!/usr/bin/env python3
"""
Bake monthly time-series cell datasets from Earth Engine into the cell store.

Each dataset is a monthly composite of a public satellite product, sampled on
a lat/lng grid aligned to DIGIPIN cells (one output pixel = one cell, same
trick as scripts/build_building_heights.py), then written through
pipeline.cells.store as a *temporal* dataset: every field holds one value per
month (docs/CELL_STORE.md, "Time series"). The web app's time slider
(js/time-slider.js) animates them.

    lst   MODIS Terra+Aqua 8-day LST (MOD11A2/MYD11A2, 1 km)   → L6 (~975 m)
          day and night land surface temperature, °C
    ndvi  MODIS Terra+Aqua 16-day vegetation (MOD13Q1/MYD13Q1, 250 m) → L7 (~244 m)
    no2   Sentinel-5P TROPOMI offline L3 NO2 (~1.1 km)           → L6 (~975 m)
          tropospheric column, µmol/m²

    python3 scripts/build_cell_timeseries.py --region indore_pilot            # all
    python3 scripts/build_cell_timeseries.py --start 2024-10 --months 24 lst  # one

Auth is the same as build_building_heights.py: GEE_SERVICE_ACCOUNT_KEY, or a
proxy-injected token in a Claude cloud session. Requires earthengine-api,
numpy, and pyarrow unless --no-parquet.
"""
import argparse
import io
import json
import os
import sys
from datetime import date

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import digipin  # noqa: E402
from _lib.regions import bbox_for  # noqa: E402
from build_building_heights import aligned_bbox, cell_size, ee_init  # noqa: E402
from pipeline.cells import store  # noqa: E402
from pipeline.cells.schema import DatasetSpec, FieldSpec, TimeSpec  # noqa: E402


NODATA = -9999.0


def months(start, n):
    """['2024-10', '2024-11', …] — n ISO month labels from `start`."""
    y, m = (int(x) for x in start.split("-"))
    out = []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def default_start(n):
    """First month of the n most recent complete months."""
    t = date.today()
    y, m = t.year, t.month - 1          # last complete month
    m -= n - 1
    while m < 1:
        y, m = y - 1, m + 12
    return f"{y:04d}-{m:02d}"


# ── per-dataset Earth Engine recipes ────────────────────────────────────────
# Each returns {field_key: ee.Image for one month}; `col_month(ee, a, b)` gets
# the month's [a, b) date range. Empty months come back fully masked → None.

def _monthly_mean(ee, ids, band, a, b, scale=1.0, offset=0.0):
    col = ee.ImageCollection(ids[0])
    for extra in ids[1:]:
        col = col.merge(ee.ImageCollection(extra))
    col = col.filterDate(a, b).select(band)
    empty = ee.Image.constant(0).updateMask(ee.Image.constant(0)).rename(band)
    img = ee.Image(ee.Algorithms.If(col.size().gt(0), col.mean(), empty))
    return img.multiply(scale).add(offset).toFloat()


def recipe_lst(ee, a, b):
    ids = ["MODIS/061/MOD11A2", "MODIS/061/MYD11A2"]
    return {
        "lst_day_c": _monthly_mean(ee, ids, "LST_Day_1km", a, b, 0.02, -273.15),
        "lst_night_c": _monthly_mean(ee, ids, "LST_Night_1km", a, b, 0.02, -273.15),
    }


def recipe_ndvi(ee, a, b):
    ids = ["MODIS/061/MOD13Q1", "MODIS/061/MYD13Q1"]
    return {"ndvi": _monthly_mean(ee, ids, "NDVI", a, b, 0.0001)}


def recipe_no2(ee, a, b):
    ids = ["COPERNICUS/S5P/OFFL/L3_NO2"]
    # mol/m² → µmol/m²
    return {"no2_umol_m2": _monthly_mean(ee, ids, "tropospheric_NO2_column_number_density", a, b, 1e6)}


DATASETS = {
    "lst": dict(
        recipe=recipe_lst, level=6, decimals=1,
        spec=lambda steps: DatasetSpec(
            id="lst_monthly", title="Land surface temperature (monthly)",
            description="Monthly mean MODIS Terra+Aqua land surface temperature, day and night. "
                        "Cloudy monsoon months have gaps.",
            source="MODIS MOD11A2/MYD11A2 v6.1 via Earth Engine (scripts/build_cell_timeseries.py)",
            license="NASA LP DAAC, public domain",
            group="Time series", level=6,
            fields=[FieldSpec("lst_day_c", "Daytime LST", unit="°C", ramp="heat", higher_is="worse"),
                    FieldSpec("lst_night_c", "Night-time LST", unit="°C", ramp="heat", higher_is="worse")],
            default_field="lst_day_c", height_m=600,
            time=TimeSpec("month", steps))),
    "ndvi": dict(
        recipe=recipe_ndvi, level=7, decimals=3,
        spec=lambda steps: DatasetSpec(
            id="ndvi_monthly", title="Vegetation NDVI (monthly)",
            description="Monthly mean MODIS 250 m NDVI (Terra+Aqua 16-day composites). "
                        "Shows the monsoon green-up and the dry-season brown-out.",
            source="MODIS MOD13Q1/MYD13Q1 v6.1 via Earth Engine (scripts/build_cell_timeseries.py)",
            license="NASA LP DAAC, public domain",
            group="Time series", level=7,
            fields=[FieldSpec("ndvi", "NDVI", unit="index", domain=[0, 0.8], ramp="greens",
                              higher_is="better")],
            default_field="ndvi", height_m=300,
            time=TimeSpec("month", steps))),
    "no2": dict(
        recipe=recipe_no2, level=6, decimals=1,
        spec=lambda steps: DatasetSpec(
            id="no2_monthly", title="Air quality: NO₂ column (monthly)",
            description="Monthly mean Sentinel-5P TROPOMI tropospheric NO₂ column. Traffic and "
                        "combustion raise it; native pixels are ~5.5 × 3.5 km, so neighbouring "
                        "cells share values.",
            source="Copernicus Sentinel-5P OFFL L3 NO2 via Earth Engine (scripts/build_cell_timeseries.py)",
            license="Copernicus Sentinel data, free and open",
            group="Time series", level=6,
            fields=[FieldSpec("no2_umol_m2", "Tropospheric NO₂", unit="µmol/m²", ramp="reds",
                              higher_is="worse")],
            default_field="no2_umol_m2", height_m=600,
            time=TimeSpec("month", steps))),
}


def fetch(ee, recipe, steps, bbox, level, decimals=4):
    """{code: {key: [v per step]}} by sampling each month on the DIGIPIN grid."""
    import numpy as np
    w, s, e, n = aligned_bbox(bbox, level)
    lat_step, lon_step = cell_size(level)
    cols, rows = round((e - w) / lon_step), round((n - s) / lat_step)
    bands, keys = [], None
    for i, step in enumerate(steps):
        y, m = (int(x) for x in step.split("-"))
        a = ee.Date.fromYMD(y, m, 1)
        imgs = recipe(ee, a, a.advance(1, "month"))
        keys = list(imgs)
        # Masked (cloudy / empty) pixels → sentinel, so NPY carries them explicitly.
        bands += [imgs[k].unmask(NODATA).rename(f"{k}__{i}") for k in keys]
    img = ee.Image.cat(bands)
    out = {}
    tile = 256   # 256² px × 48 float32 bands ≈ 12 MB, under computePixels' 48 MB cap
    print(f"  {cols}x{rows} cells x {len(bands)} bands, tile {tile}px")
    for r0 in range(0, rows, tile):
        for c0 in range(0, cols, tile):
            h, wd = min(tile, rows - r0), min(tile, cols - c0)
            raw = ee.data.computePixels({
                "expression": img,
                "fileFormat": "NPY",
                "grid": {
                    "dimensions": {"width": wd, "height": h},
                    "affineTransform": {
                        "scaleX": lon_step, "shearX": 0, "translateX": w + c0 * lon_step,
                        "shearY": 0, "scaleY": -lat_step, "translateY": n - r0 * lat_step,
                    },
                    "crsCode": "EPSG:4326",
                },
            })
            arr = np.load(io.BytesIO(raw))
            for r in range(h):
                lat = n - (r0 + r + 0.5) * lat_step
                for c in range(wd):
                    lng = w + (c0 + c + 0.5) * lon_step
                    code = digipin.encode(lat, lng).replace("-", "")[:level]
                    series = {}
                    for k in keys:
                        vals = []
                        for i in range(len(steps)):
                            v = float(arr[f"{k}__{i}"][r, c])
                            vals.append(round(v, decimals) if np.isfinite(v) and v > NODATA / 2 else None)
                        series[k] = vals
                    out[code] = series
            print(f"    tile r{r0} c{c0}: {len(out)} cells")
    return out, keys


def robust_domains(spec, table, lo_pct=2, hi_pct=98):
    """Fill missing number domains with the 2nd–98th percentile over all steps.

    A min/max domain lets one bad pixel (a cloud-contaminated −1 °C LST cell)
    wash out the colour ramp for every month; percentiles keep it legible.
    """
    from dataclasses import replace
    import numpy as np
    fields = []
    for f in spec.fields:
        if f.domain is None:
            vals = [v for s in table.columns[f.key] for v in s if v is not None]
            if vals:
                lo, hi = np.percentile(vals, [lo_pct, hi_pct])
                f = replace(f, domain=[round(float(lo), 2), round(float(hi), 2)])
        fields.append(f)
    return replace(spec, fields=fields)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("datasets", nargs="*", help=f"subset of {sorted(DATASETS)} (default: all)")
    ap.add_argument("--region", default="indore_pilot")
    ap.add_argument("--months", type=int, default=24)
    ap.add_argument("--start", help="first month YYYY-MM (default: the last --months complete months)")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "cells"))
    ap.add_argument("--no-parquet", action="store_true")
    a = ap.parse_args()
    unknown = set(a.datasets) - set(DATASETS)
    if unknown:
        ap.error(f"unknown dataset(s) {sorted(unknown)}; known: {sorted(DATASETS)}")

    steps = months(a.start or default_start(a.months), a.months)
    bbox = bbox_for(a.region)
    ee = ee_init()
    for name in a.datasets or list(DATASETS):
        d = DATASETS[name]
        print(f"{name}: {steps[0]}..{steps[-1]} at L{d['level']}")
        rows, keys = fetch(ee, d["recipe"], steps, bbox, d["level"], d["decimals"])
        spec = d["spec"](steps)
        table = store.series_table(d["level"], steps, rows, keys)
        spec = robust_domains(spec, table)
        print(json.dumps(store.write_dataset(a.out, spec, a.region, table, parquet=not a.no_parquet)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
