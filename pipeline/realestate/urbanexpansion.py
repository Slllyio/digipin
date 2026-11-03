"""The 2015 forecast of where cities would spread by 2030, per block, from the Global Grid of Probabilities of Urban
Expansion to 2030 (Seto, Güneralp and Hutyra 2015; NASA SEDAC / CIESIN, free to use with attribution, commercial use
allowed).

The grid (2.5 arc-minutes, about 5 km) starts from MODIS urban land circa 2000 and, for every cell that was not urban
then, gives the Monte-Carlo probability (0-100) that it becomes urban by 2030, driven by GRUMP population density and
regional population and GDP projections. Cells urban in 2000 carry the value 101. Each lived-in L7 block takes the cell at
its centre (dataset ``urban_expansion``):

    urban_2000   1 if the cell was already urban circa 2000 (MODIS), else 0
    p2030        forecast probability (0-100) of turning urban by 2030; blank where already urban in 2000

Because the forecast was made from 2000 data, comparing it with what was actually built since (GHSL 2000-2020) is a
hindcast: it shows where cities grew as expected and where growth surprised the model.

Get the zip (1.4 MB) with Earthdata access:
https://data.earthdata.nasa.gov/nasa-earth/human-dimensions/sedac-root/downloads/data/lulc/lulc-global-grid-prob-urban-expansion-2030/global-grid-prob-urban-expansion-2030.zip

    python -m pipeline.realestate.urbanexpansion --tif /path/global-grid-prob-urban-expansion-2030-wgs84.tif --region delhi
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
DEFAULT_TIF = "/tmp/claude-0/uexp/global-grid-prob-urban-expansion-2030-wgs84.tif"
URBAN = 101


def rows_from(cells, values, nodata=None):
    """cells [(code, lat, lng)], values [raw grid value per cell] -> {code: row}; 0-100 is a probability, 101 urban in 2000."""
    out = {}
    for (code, _, _), v in zip(cells, values):
        if v is None or (nodata is not None and v == nodata):
            continue
        v = int(v)
        if v == URBAN:
            out[code] = {"urban_2000": 1, "p2030": None}
        elif 0 <= v <= 100:
            out[code] = {"urban_2000": 0, "p2030": v}
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
    specs = [
        FieldSpec("urban_2000", "Already urban circa 2000 (MODIS)", agg="mean", unit="share", domain=[0, 1], ramp="viridis"),
        FieldSpec("p2030", "2015 forecast: chance of turning urban by 2030", agg="mean", unit="%", domain=[0, 100], ramp="heat"),
    ]
    spec = DatasetSpec(
        id="urban_expansion", title="Urban expansion forecast to 2030 (SEDAC, 2015)", level=LEVEL, fields=specs, group="Real estate",
        description="Global Grid of Probabilities of Urban Expansion to 2030 (Seto et al. 2015, ~5 km): MODIS urban land circa 2000 "
                    "and, for land not urban then, the Monte-Carlo probability of becoming urban by 2030 from population density "
                    "and regional population and GDP projections. Sampled at each lived-in block's centre.",
        source="pipeline/realestate/urbanexpansion.py (NASA SEDAC lulc-global-grid-prob-urban-expansion-2030 GeoTIFF)",
        license="Free to use, copy and adapt incl. commercially with attribution (Seto, Güneralp & Hutyra 2015; NASA SEDAC, doi:10.7927/H4Z899CG)",
        default_field="p2030", extrude=False)
    clean = ({"digipin": c, **{k: v for k, v in r.items() if v is not None}} for c, r in rows.items())
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
        urb = sum(r["urban_2000"] for r in rows.values())
        p = sorted(r["p2030"] for r in rows.values() if r["p2030"] is not None)
        med = p[len(p) // 2] if p else None
        print(f"{region}: {len(rows)} blocks, {100 * urb / len(rows):.0f}% urban in 2000, forecast median {med} for the rest; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
