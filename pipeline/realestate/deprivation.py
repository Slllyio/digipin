"""Relative deprivation per block from the Global Gridded Relative Deprivation Index, GRDI v1 (NASA SEDAC / CIESIN,
2010-2020 inputs; CC BY 4.0, commercial use allowed).

GRDI scores each ~1 km pixel from 0 (least deprived) to 100 (most deprived) by combining six components: built-up
density, VIIRS night lights in 2020 and their 2012-2020 trend, child dependency ratio, infant mortality rate and the
subnational Human Development Index. It is an openly licensed alternative to proprietary wealth estimates; the last three
components are state- or district-level, so differences inside a city come mostly from built-up density and lights.
Each lived-in L7 block takes the pixel at its centre (dataset ``deprivation``):

    grdi    relative deprivation, 0 (least) to 100 (most)

Get the GeoTIFF (118 MB zip) with Earthdata access:
https://data.earthdata.nasa.gov/nasa-earth/human-dimensions/sedac-root/downloads/data/povmap/povmap-grdi-v1/povmap-grdi-v1-grdiv1-geotiff.zip

    python -m pipeline.realestate.deprivation --tif /path/povmap-grdi-v1.tif --region delhi
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
DEFAULT_TIF = "/tmp/claude-0/grdi/povmap-grdi-v1.tif"


def rows_from(cells, values, nodata=None):
    """cells [(code, lat, lng)], values [float per cell] -> {code: {'grdi': v}} for valid 0-100 values."""
    out = {}
    for (code, _, _), v in zip(cells, values):
        if v is None or (nodata is not None and v == nodata) or not 0 <= v <= 100:
            continue
        out[code] = {"grdi": round(float(v), 1)}
    return out


def fetch(region, tif):
    import rasterio

    from pipeline.realestate.powerplants import lived_cells
    cells = lived_cells(region)
    with rasterio.open(tif) as src:
        vals = [x[0] for x in src.sample([(ln, la) for _, la, ln in cells])]
        return rows_from(cells, vals, src.nodata)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("grdi", "Relative deprivation (GRDI v1, 0 least to 100 most)", agg="mean", unit="0-100", domain=[0, 100], ramp="reds", higher_is="worse")]
    spec = DatasetSpec(
        id="deprivation", title="Relative deprivation (NASA SEDAC GRDI v1)", level=LEVEL, fields=specs, group="Real estate",
        description="Global Gridded Relative Deprivation Index v1 (~1 km): built-up density, night lights and their trend, child "
                    "dependency, infant mortality and subnational HDI, indexed 0-100. Sampled at each lived-in block's centre.",
        source="pipeline/realestate/deprivation.py (NASA SEDAC povmap-grdi-v1 GeoTIFF)",
        license="CC BY 4.0 (CIESIN, Columbia University, 2022; NASA SEDAC, doi:10.7927/3xxe-ap97)", default_field="grdi", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    ap.add_argument("--tif", default=DEFAULT_TIF)
    a = ap.parse_args(argv)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        rows = fetch(region, a.tif)
        if not rows:
            print(f"{region}: none")
            continue
        info = cell_dataset(region, rows)
        v = sorted(r["grdi"] for r in rows.values())
        print(f"{region}: {len(v)} blocks, GRDI median {v[len(v) // 2]}, 10th {v[len(v) // 10]}, 90th {v[9 * len(v) // 10]}; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
