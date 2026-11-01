"""Fossil-fuel CO2 emissions per block, 2004 and 2024, from ODIAC2025 (Open-source Data Inventory for Anthropogenic CO2,
Oda and Maksyutov; National Institute for Environmental Studies, Japan; CC BY 4.0, commercial use allowed).

ODIAC spreads national fossil-fuel CO2 totals (combustion and cement, excluding international aviation and shipping) on a
30 arc-second (~1 km) grid: large power plants are placed at their own coordinates and the rest follows satellite night
lights. Monthly grids in tonnes of carbon per cell are summed to a year and converted to tonnes of CO2 per km². This is
the openly licensed stand-in for EDGAR's CO2 grids, whose fossil CO2 inputs carry a non-commercial licence. Each lived-in
L7 block takes the pixel at its centre (dataset ``fossil_co2``):

    co2_2004 / co2_2024   fossil CO2 emitted in that ~1 km pixel, t CO2 per km² per year
    co2_change_pct        change 2004 -> 2024 (%; blank where 2004 was under 100 t/km²)

Night lights stand in for where fuel is burnt, so busy lit districts carry emissions from traffic, homes and shops alike
and a dark industrial estate can be understated.

The monthly files (~100 MB gz, 3.7 GB unpacked each) are at
https://db.cger.nies.go.jp/nies_data/10.17595/20170411.001/odiac2025/1km_tiff/<year>/odiac2025_1km_excl_intl_<yymm>.tif.gz
crop each to India (68-98 E, 6-37 N) and sum the twelve into india_<year>.npy, then

    python -m pipeline.realestate.fossilco2 --dir /tmp/claude-0/odiac --region delhi
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
DEFAULT_DIR = "/tmp/claude-0/odiac"
WEST, NORTH, RES = 68.0, 37.0, 1 / 120  # the India crop's top-left corner and pixel size (degrees)
C_TO_CO2 = 44 / 12
YEARS = (2004, 2024)
MIN_BASE = 100.0  # t CO2/km² below which a percentage change is noise


def pixel_km2(lat):
    return (111.32 * RES) ** 2 * math.cos(math.radians(lat))


def per_km2(t_carbon, lat):
    """Tonnes of carbon in one pixel in a year -> t CO2 per km²."""
    return t_carbon * C_TO_CO2 / pixel_km2(lat)


def rows_from(cells, old, new):
    """cells [(code, lat, lng)], old/new [t C per pixel per year or None] -> {code: row}."""
    out = {}
    for (code, lat, _), a, b in zip(cells, old, new):
        if b is None or b < 0:
            continue
        r = {"co2_2024": round(per_km2(b, lat))}
        if a is not None and a >= 0:
            r["co2_2004"] = round(per_km2(a, lat))
            if r["co2_2004"] >= MIN_BASE:
                r["co2_change_pct"] = round(100 * (r["co2_2024"] / r["co2_2004"] - 1))
        out[code] = r
    return out


def sample(grid, cells):
    h, w = grid.shape
    out = []
    for _, lat, lng in cells:
        i, j = int((NORTH - lat) / RES), int((lng - WEST) / RES)
        out.append(float(grid[i, j]) if 0 <= i < h and 0 <= j < w else None)
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("co2_2024", "Fossil CO2 emitted, 2024", agg="mean", unit="t CO2/km²/yr", ramp="reds", higher_is="worse"),
        FieldSpec("co2_2004", "Fossil CO2 emitted, 2004", agg="mean", unit="t CO2/km²/yr", ramp="reds", higher_is="worse"),
        FieldSpec("co2_change_pct", "Change in fossil CO2, 2004 to 2024", agg="mean", unit="%", ramp="diverging", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="fossil_co2", title="Fossil-fuel CO2 per km², 2004 and 2024 (ODIAC2025)", level=LEVEL, fields=specs, group="Environment",
        description="ODIAC2025 fossil-fuel CO2 (combustion and cement, no international bunkers) on a ~1 km grid: point sources at "
                    "their own location, the rest spread by satellite night lights. Monthly tonnes of carbon summed per year and "
                    "converted to t CO2 per km². Sampled at each lived-in block's centre.",
        source="pipeline/realestate/fossilco2.py (NIES ODIAC2025 1 km monthly GeoTIFFs)",
        license="CC BY 4.0 (Oda T. & Maksyutov S., ODIAC Fossil Fuel CO2 Emissions Dataset, NIES, doi:10.17595/20170411.001)",
        default_field="co2_2024", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import numpy as np

    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    ap.add_argument("--dir", default=DEFAULT_DIR)
    a = ap.parse_args(argv)
    old, new = (np.load(Path(a.dir) / f"india_{y}.npy", mmap_mode="r") for y in YEARS)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        cells = lived_cells(region)
        rows = rows_from(cells, sample(old, cells), sample(new, cells))
        info = cell_dataset(region, rows)
        v = sorted(r["co2_2024"] for r in rows.values())
        print(f"{region}: {len(v)} blocks, median {v[len(v) // 2]} t/km², 90th {v[9 * len(v) // 10]}; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
