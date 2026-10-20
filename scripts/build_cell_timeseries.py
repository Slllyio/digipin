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
from _lib.regions import CITY_PILOTS, bbox_for  # noqa: E402
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

def _monthly_mean(ee, ids, band, a, b, scale=1.0, offset=0.0, reduce="mean", where=None):
    """One image for [a, b): the mean (or sum) of `band` over the merged collections."""
    col = ee.ImageCollection(ids[0])
    for extra in ids[1:]:
        col = col.merge(ee.ImageCollection(extra))
    col = col.filterDate(a, b)
    if where is not None:
        col = col.filter(where)
    col = col.select(band)
    empty = ee.Image.constant(0).updateMask(ee.Image.constant(0)).rename(band)
    agg = col.sum() if reduce == "sum" else col.mean()
    img = ee.Image(ee.Algorithms.If(col.size().gt(0), agg, empty))
    return img.multiply(scale).add(offset).toFloat()


def recipe_lst(ee, a, b, label=None):
    ids = ["MODIS/061/MOD11A2", "MODIS/061/MYD11A2"]
    return {
        "lst_day_c": _monthly_mean(ee, ids, "LST_Day_1km", a, b, 0.02, -273.15),
        "lst_night_c": _monthly_mean(ee, ids, "LST_Night_1km", a, b, 0.02, -273.15),
    }


def recipe_ndvi(ee, a, b, label=None):
    ids = ["MODIS/061/MOD13Q1", "MODIS/061/MYD13Q1"]
    return {"ndvi": _monthly_mean(ee, ids, "NDVI", a, b, 0.0001)}


def recipe_no2(ee, a, b, label=None):
    ids = ["COPERNICUS/S5P/OFFL/L3_NO2"]
    # mol/m² → µmol/m²
    return {"no2_umol_m2": _monthly_mean(ee, ids, "tropospheric_NO2_column_number_density", a, b, 1e6)}


def recipe_rain(ee, a, b, label=None):
    # CHIRPS daily rainfall (mm/day) summed over the month → mm.
    return {"rain_mm": _monthly_mean(ee, ["UCSB-CHG/CHIRPS/DAILY"], "precipitation", a, b, reduce="sum")}


def recipe_lights(ee, a, b, label=None):
    # VIIRS DNB monthly, stray-light corrected; radiance nW/cm²/sr.
    return {"radiance": _monthly_mean(ee, ["NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG"], "avg_rad", a, b)}


def recipe_pm25(ee, a, b, label=None):
    # CAMS near-real-time forecasts: keep the first 24 h of each 00 UTC run so
    # every hour of the month is counted once. kg/m³ → µg/m³.
    first_day = ee.Filter.And(ee.Filter.eq("model_initialization_hour", 0),
                              ee.Filter.lt("model_forecast_hour", 24))
    return {"pm25_ugm3": _monthly_mean(ee, ["ECMWF/CAMS/NRT"], "particulate_matter_d_less_than_25_um_surface",
                                       a, b, 1e9, where=first_day)}


def recipe_built(ee, a, b, label=None):
    # GHSL built-up surface (m² per 100 m pixel) for the epoch → share of land built.
    img = (ee.ImageCollection("JRC/GHSL/P2023A/GHS_BUILT_S")
           .filter(ee.Filter.eq("system:index", str(label))).first().select("built_surface"))
    # Average the 100 m pixels up to the cell rather than sampling one of them.
    img = img.divide(100).reduceResolution(ee.Reducer.mean(), maxPixels=1024)   # m²/10,000 m² × 100
    return {"built_pct": img.toFloat()}


GHSL_EPOCHS = [str(y) for y in range(1975, 2021, 5)]

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
    "rain": dict(
        recipe=recipe_rain, level=5, decimals=1,
        spec=lambda steps: DatasetSpec(
            id="rain_monthly", title="Rainfall (monthly total)",
            description="CHIRPS satellite-gauge rainfall summed per month. Native pixels are "
                        "~5.5 km, so this is drawn on ~3.9 km cells.",
            source="CHIRPS v2.0 daily (UCSB Climate Hazards Center) via Earth Engine "
                   "(scripts/build_cell_timeseries.py)",
            license="CHIRPS, public domain (CC0)",
            group="Time series", level=5,
            fields=[FieldSpec("rain_mm", "Rainfall", unit="mm", ramp="blues")],
            default_field="rain_mm", height_m=1500,
            time=TimeSpec("month", steps))),
    "lights": dict(
        recipe=recipe_lights, level=7, decimals=2,
        spec=lambda steps: DatasetSpec(
            id="nightlights_monthly", title="Night lights (monthly)",
            description="VIIRS Day/Night Band monthly radiance, stray-light corrected. Tracks "
                        "built-up activity, electrification and festival lighting.",
            source="NOAA EOG VIIRS DNB monthly (VCMSLCFG) via Earth Engine "
                   "(scripts/build_cell_timeseries.py)",
            license="NOAA EOG, free with attribution",
            group="Time series", level=7,
            fields=[FieldSpec("radiance", "Night-time radiance", unit="nW/cm²/sr", ramp="viridis")],
            default_field="radiance", height_m=300,
            time=TimeSpec("month", steps))),
    "pm25": dict(
        recipe=recipe_pm25, level=5, decimals=1,
        spec=lambda steps: DatasetSpec(
            id="pm25_monthly", title="Air quality: PM2.5 (monthly, modelled)",
            description="Monthly mean surface PM2.5 from the CAMS global forecast model "
                        "(~40 km grid, so whole districts share a value). A model estimate, "
                        "not a monitor reading.",
            source="Copernicus Atmosphere Monitoring Service near-real-time forecasts via "
                   "Earth Engine (scripts/build_cell_timeseries.py)",
            license="Copernicus, free and open",
            group="Time series", level=5,
            fields=[FieldSpec("pm25_ugm3", "Surface PM2.5", unit="µg/m³", ramp="reds",
                              higher_is="worse")],
            default_field="pm25_ugm3", height_m=1500,
            time=TimeSpec("month", steps))),
    "built": dict(
        recipe=recipe_built, level=7, decimals=1, steps=GHSL_EPOCHS,
        spec=lambda steps: DatasetSpec(
            id="builtup_yearly", title="Built-up land, 1975–2020",
            description="Share of each cell covered by buildings in each GHSL epoch "
                        "(every 5 years), from Landsat and Sentinel-2. Play it to watch "
                        "the city grow.",
            source="JRC GHSL GHS-BUILT-S R2023A via Earth Engine (scripts/build_cell_timeseries.py)",
            license="JRC GHSL, CC BY 4.0",
            group="Time series", level=7,
            fields=[FieldSpec("built_pct", "Built-up share", unit="%", domain=[0, 60],
                              ramp="heat")],
            default_field="built_pct", height_m=300,
            time=TimeSpec("year", steps))),
}


def step_range(ee, label):
    """[start, end) ee.Dates of an ISO year or month label."""
    parts = [int(x) for x in label.split("-")]
    if len(parts) == 1:
        a = ee.Date.fromYMD(parts[0], 1, 1)
        return a, a.advance(1, "year")
    a = ee.Date.fromYMD(parts[0], parts[1], 1)
    return a, a.advance(1, "month")


def fetch(ee, recipe, steps, bbox, level, decimals=4):
    """{code: {key: [v per step]}} by sampling each step on the DIGIPIN grid."""
    import numpy as np
    w, s, e, n = aligned_bbox(bbox, level)
    lat_step, lon_step = cell_size(level)
    cols, rows = round((e - w) / lon_step), round((n - s) / lat_step)
    bands, keys = [], None
    for i, step in enumerate(steps):
        a, b = step_range(ee, step)
        imgs = recipe(ee, a, b, step)
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


def pooled_domains(out, spec, lo_pct=2, hi_pct=98):
    """Set each data-derived domain to the 2nd–98th percentile over every
    region and step already in the store, then patch catalog.json.

    One domain for all cities keeps a colour meaning the same °C in Delhi
    and in Chennai, and percentiles stop one bad pixel (a cloud-contaminated
    −1 °C LST cell) washing out the ramp. Fields with an explicit domain in
    the spec (NDVI's 0–0.8) are left alone.
    """
    import numpy as np
    path = os.path.join(out, store.CATALOG)
    with open(path) as fh:
        cat = json.load(fh)
    entry = next(d for d in cat["datasets"] if d["id"] == spec.id)
    tables = [store.read_region(out, r) for r in entry["regions"]]
    for f in entry["fields"]:
        if next(x for x in spec.fields if x.key == f["key"]).domain is not None:
            continue
        vals = [v for t in tables for s in t.columns[f["key"]] for v in s if v is not None]
        if vals:
            lo, hi = np.percentile(vals, [lo_pct, hi_pct])
            f["domain"] = [round(float(lo), 2), round(float(hi), 2)]
    with open(path + ".tmp", "w") as fh:
        fh.write(json.dumps(cat, indent=2) + "\n")
    os.replace(path + ".tmp", path)
    return {f["key"]: f.get("domain") for f in entry["fields"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("datasets", nargs="*", help=f"subset of {sorted(DATASETS)} (default: all)")
    ap.add_argument("--region", default="indore_pilot",
                    help="region key, comma-separated keys, or 'all' (every city pilot)")
    ap.add_argument("--months", type=int, default=24)
    ap.add_argument("--start", help="first month YYYY-MM (default: the last --months complete months)")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "cells"))
    ap.add_argument("--no-parquet", action="store_true")
    a = ap.parse_args()
    unknown = set(a.datasets) - set(DATASETS)
    if unknown:
        ap.error(f"unknown dataset(s) {sorted(unknown)}; known: {sorted(DATASETS)}")

    steps = months(a.start or default_start(a.months), a.months)
    regions = list(CITY_PILOTS) if a.region == "all" else a.region.split(",")
    ee = ee_init()
    for name in a.datasets or list(DATASETS):
        d = DATASETS[name]
        ds_steps = d.get("steps", steps)
        spec = d["spec"](ds_steps)
        for region in regions:
            print(f"{name} / {region}: {ds_steps[0]}..{ds_steps[-1]} at L{d['level']}")
            rows, keys = fetch(ee, d["recipe"], ds_steps, bbox_for(region), d["level"], d["decimals"])
            table = store.series_table(d["level"], ds_steps, rows, keys)
            print(json.dumps(store.write_dataset(a.out, spec, region, table, parquet=not a.no_parquet)))
        print(json.dumps({"dataset": spec.id, "domains": pooled_domains(a.out, spec)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
