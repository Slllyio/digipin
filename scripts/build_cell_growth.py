#!/usr/bin/env python3
"""
Bake the ``growth`` cell dataset (urban growth) for any city in regions.py.

Indore's copy comes from the 100 m COGs in data/growth/ (pipeline/cells/build.py).
Every other city is built here straight from Earth Engine, with the same model:

  1. Google Open Buildings Temporal ``building_presence`` per year 2016..2023,
     sampled on the DIGIPIN level-8 grid (~61 m, 16 pixels per level-7 cell).
  2. Driver layers on the same grid: slope (Copernicus GLO-30), distance to
     water (JRC Global Surface Water), population (GHSL 2020), night-lights
     (VIIRS 2023) and distance to existing built-up.
  3. The CA-RF model in pipeline/growth/urban_ca_ml.py: hindcast 2016→2020→2023
     (Figure of Merit + Kappa, written to data/growth/ca_validation_<region>.json),
     then train on 2016→2023 and run the CA forward to 2035.
  4. Pixels averaged into level-7 cells → built_2016_pct, built_2023_pct,
     built_change_pp, urban_2035_pct, written through pipeline.cells.store as a
     new region of the ``growth`` dataset (one region per city in catalog.json).

    python3 scripts/build_cell_growth.py                 # every city but Indore
    python3 scripts/build_cell_growth.py pune delhi      # some
    python3 scripts/build_cell_growth.py --region-out indore_check indore_pilot

OSM roads are not a driver here (Indore's are local vectors; there is no OSM in
Earth Engine), distance to existing built-up stands in for road access.

Auth is the same as build_building_heights.py. Requires earthengine-api, numpy,
scipy, scikit-learn, and pyarrow unless --no-parquet.
"""
import argparse
import io
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lib import digipin  # noqa: E402
from _lib.regions import CITY_PILOTS, bbox_for  # noqa: E402
from build_building_heights import aligned_bbox, cell_size, ee_init  # noqa: E402
from pipeline.cells import store  # noqa: E402
from pipeline.cells.build import growth_spec  # noqa: E402
from pipeline.growth import ca_drivers, urban_ca_ml as ca  # noqa: E402

LEVEL = 7          # output cells (~244 m)
GRID_LEVEL = 8     # model grid (~61 m)
YEARS = ca.YEARS   # 2016..2023
HORIZON = 2035
OB_TEMPORAL = "GOOGLE/Research/open-buildings-temporal/v1"


def ee_stack(ee):
    """One multi-band image: presence_<year> for each year + the raw drivers."""
    col = ee.ImageCollection(OB_TEMPORAL).select("building_presence")
    bands = [col.filterDate(f"{y}-01-01", f"{y + 1}-01-01").mean().unmask(0)
             .rename(f"presence_{y}") for y in YEARS]
    dem = ee.ImageCollection("COPERNICUS/DEM/GLO30").select("DEM").mosaic().rename("dem")
    water = (ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence").unmask(0)
             .rename("water"))
    pop = ee.Image("JRC/GHSL/P2023A/GHS_POP/2020").select("population_count").unmask(0).rename("pop")
    viirs = (ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG").filterDate("2023-01-01", "2024-01-01")
             .select("avg_rad").median().unmask(0).rename("viirs"))
    return ee.Image.cat(bands + [dem, water, pop, viirs]).toFloat()


def fetch_grid(ee, img, bbox, level, tile=256):
    """{band: (H, W) float32} of `img` on the DIGIPIN `level` grid covering bbox,
    plus the grid origin (west, north) and steps. Row 0 is the north edge."""
    import numpy as np
    w, s, e, n = aligned_bbox(bbox, level)
    lat_step, lon_step = cell_size(level)
    cols, rows = round((e - w) / lon_step), round((n - s) / lat_step)
    names = img.bandNames().getInfo()
    out = {b: np.zeros((rows, cols), dtype="float32") for b in names}
    print(f"  grid L{level}: {cols}x{rows} px x {len(names)} bands")
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
            for b in names:
                out[b][r0:r0 + h, c0:c0 + wd] = np.nan_to_num(arr[b], nan=0.0)
    return out, (w, n, lat_step, lon_step)


def model(grid, res_m):
    """Run the CA-RF hindcast + projection on fetched arrays.

    Returns (prob_2035 (H, W), metrics). Mirrors urban_ca_ml.run(), with
    distance-to-built recomputed from the start year of each fit.
    """
    import numpy as np
    pres = [grid[f"presence_{y}"] for y in YEARS]
    u2016, u2020, u2023 = pres[0], pres[YEARS.index(2020)], pres[-1]
    static = [
        ca_drivers.normalize01(ca_drivers.slope_from_dem(grid["dem"], res_m)),
        ca_drivers.normalize01(ca_drivers.distance_field(grid["water"] >= 50, res_m)),
        ca_drivers.normalize01(grid["pop"]),
        ca_drivers.normalize01(grid["viirs"]),
    ]

    def drivers(u0):
        d = ca_drivers.normalize01(ca_drivers.distance_field(ca.urban_mask(u0), res_m))
        return np.stack(static + [d], axis=-1).astype("float32")

    # Subsample RF rows: a metro is ~1M pixels; 25% per tree keeps it minutes.
    rf = dict(max_samples=0.25)

    # Hindcast: train 2016→2020, simulate to 2023, score against observed 2023.
    _, pot = ca.train_transition(drivers(u2016), u2016, u2020, **rf)
    demand = ca.markov_demand([ca.urban_mask(u2016), ca.urban_mask(u2020)])
    pred = ca.simulate(pot, u2020, demand, steps=3)
    metrics = {
        "figure_of_merit": ca.figure_of_merit(ca.urban_mask(u2020), ca.urban_mask(u2023), pred),
        "kappa": ca.kappa(ca.urban_mask(u2023), pred),
        "demand_per_step": demand,
    }

    # Full record 2016→2023, potential evaluated with 2023's built-up, run to HORIZON.
    m, pot = ca.train_transition(drivers(u2016), u2016, u2023, **rf)
    urban = ca.urban_mask(u2023).copy()
    if hasattr(m, "estimators_"):
        X = drivers(u2023)
        pot = m.predict_proba(X.reshape(-1, X.shape[-1]))[:, 1].reshape(urban.shape).astype("float32")
        pot[urban] = 0.0
    demand = ca.markov_demand([ca.urban_mask(p) for p in pres])
    steps = max(0, HORIZON - YEARS[-1])
    prob = np.where(urban, 1.0, 0.0).astype("float32")
    for s in range(steps):
        nxt = ca.allocate_step(pot, urban, demand)
        prob[nxt & ~urban] = 1.0 - (s / max(1, steps)) * 0.6   # sooner ⇒ higher confidence
        urban = nxt
    prob = np.maximum(prob, pot * 0.4).astype("float32")
    metrics.update(horizon=HORIZON, urban_px_2016=int(ca.urban_mask(u2016).sum()),
                   urban_px_2023=int(ca.urban_mask(u2023).sum()), grid_level=GRID_LEVEL,
                   pixels=int(urban.size))
    return prob, metrics


def to_cells(grid, prob, origin):
    """Average the model-grid pixels into level-LEVEL cells → CellTable."""
    import numpy as np
    w, n, lat_step, lon_step = origin
    b16, b23 = grid["presence_2016"], grid["presence_2023"]
    rows, cols = b16.shape
    acc = {}
    for r in range(rows):
        lat = n - (r + 0.5) * lat_step
        for c in range(cols):
            code = digipin.encode(lat, w + (c + 0.5) * lon_step).replace("-", "")[:LEVEL]
            a = acc.setdefault(code, [0.0, 0.0, 0.0, 0])
            a[0] += b16[r, c]; a[1] += b23[r, c]; a[2] += prob[r, c]; a[3] += 1
    spec = growth_spec(LEVEL)
    codes, cols_ = [], {f.key: [] for f in spec.fields}
    for code in sorted(acc):
        s16, s23, sp, k = acc[code]
        row = {"built_2016_pct": 100 * s16 / k, "built_2023_pct": 100 * s23 / k,
               "urban_2035_pct": 100 * sp / k}
        row["built_change_pp"] = row["built_2023_pct"] - row["built_2016_pct"]
        if not any(abs(v) > 1e-6 for v in row.values()):   # open land, as for Indore
            continue
        codes.append(code)
        for k_, v in row.items():
            cols_[k_].append(float(np.round(v, 3)))
    return spec, store.CellTable(level=LEVEL, codes=codes, columns=cols_)


def summary(table):
    """Per-city sanity numbers for the build log."""
    import numpy as np
    out = {"cells": len(table)}
    for k, v in table.columns.items():
        a = np.asarray(v, dtype="float64")
        out[k] = {"mean": round(float(a.mean()), 2), "p50": round(float(np.median(a)), 2),
                  "p99": round(float(np.percentile(a, 99)), 2),
                  "min": round(float(a.min()), 2), "max": round(float(a.max()), 2)}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("regions", nargs="*", help="cities from regions.py (default: all but indore_pilot)")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "cells"))
    ap.add_argument("--region-out", help="register under this region name instead (one region only)")
    ap.add_argument("--no-parquet", action="store_true")
    a = ap.parse_args()
    regions = a.regions or [r for r in CITY_PILOTS if r != "indore_pilot"]
    if a.region_out and len(regions) != 1:
        ap.error("--region-out needs exactly one region")

    ee = ee_init()
    img = ee_stack(ee)
    res_m = cell_size(GRID_LEVEL)[0] * 111_320
    for region in regions:
        print(f"{region}: {bbox_for(region)}")
        grid, origin = fetch_grid(ee, img, bbox_for(region), GRID_LEVEL)
        prob, metrics = model(grid, res_m)
        print("  hindcast", json.dumps(metrics))
        spec, table = to_cells(grid, prob, origin)
        name = a.region_out or region
        stats = summary(table)
        print("  cells", json.dumps(stats))
        with open(os.path.join(ROOT, "data", "growth", f"ca_validation_{name}.json"), "w") as fh:
            json.dump({**metrics, "cells": stats}, fh, indent=1)
            fh.write("\n")
        print(json.dumps(store.write_dataset(a.out, spec, name, table, parquet=not a.no_parquet)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
