"""How each block was governed in the 2011 Census: statutory town, census town, outgrowth or village, from SEDAC's Spatial
Data from the 2011 India Census (Balk et al., CIESIN; CC BY 4.0, commercial use allowed).

A statutory town has a municipal body; a census town is urban by the census (5,000+ people, 75% of men outside farming,
400+ per km²) but still run by a gram panchayat; an outgrowth is a dense patch next to a town but outside it, also under
rural government. Land that is built up but still under rural government gets weaker water, sewer and planning control
and is where many unauthorised colonies grew. The census-class grid (~1 km, majority class) is sampled at each lived-in
L7 block's centre (dataset ``settlement_2011``):

    s11_town / s11_census_town / s11_outgrowth / s11_village   1 for the block's 2011 class

Boundaries have moved since 2011 (Bengaluru, Hyderabad, Pune and others absorbed villages), so this is the 2011 picture.

Get the GeoTIFF with Earthdata access:
https://data.earthdata.nasa.gov/nasa-earth/human-dimensions/sedac-root/downloads/data/india/india-spatial-india-census-2011/india-spatial-india-census-2011-census-class-geotiff.zip

    python -m pipeline.realestate.settlement2011 --tif /path/india-spatial-india-census-2011_census-class.tif
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
DEFAULT_TIF = "/tmp/claude-0/indcen/india-spatial-india-census-2011-census-class-geotiff/india-spatial-india-census-2011_census-class.tif"
CLASSES = {1: "s11_village", 2: "s11_town", 3: "s11_census_town", 4: "s11_outgrowth"}  # 5 = uninhabited


def rows_from(cells, values):
    """cells [(code, lat, lng)], raster class values -> {code: one-hot fields}; uninhabited and nodata are skipped."""
    out = {}
    for (code, _, _), v in zip(cells, values):
        key = CLASSES.get(int(v)) if v is not None else None
        if key:
            out[code] = {k: int(k == key) for k in CLASSES.values()}
    return out


def fetch(region, tif):
    import rasterio

    from pipeline.realestate.powerplants import lived_cells
    cells = lived_cells(region)
    with rasterio.open(tif) as src:
        return rows_from(cells, [x[0] for x in src.sample([(ln, la) for _, la, ln in cells])])


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    flag = lambda k, label: FieldSpec(k, label, agg="mean", unit="share of blocks", domain=[0, 1], ramp="viridis")
    specs = [flag("s11_town", "Statutory town in 2011 (municipal body)"), flag("s11_census_town", "Census town in 2011 (urban, rural government)"),
             flag("s11_outgrowth", "Outgrowth of a town in 2011 (rural government)"), flag("s11_village", "Village in 2011")]
    spec = DatasetSpec(
        id="settlement_2011", title="How each block was governed in 2011 (Census settlement class, SEDAC)", level=LEVEL, fields=specs,
        group="Real estate",
        description="Majority 2011 Census settlement class (statutory town, census town, outgrowth, village) of the ~1 km cell at each "
                    "lived-in block's centre, from SEDAC's Spatial Data from the 2011 India Census.",
        source="pipeline/realestate/settlement2011.py (SEDAC india-spatial-india-census-2011 census-class GeoTIFF)",
        license="CC BY 4.0 (Balk et al., CIESIN 2020, NASA SEDAC)", default_field="s11_town", extrude=False)
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
        n = {k: sum(r[k] for r in rows.values()) for k in CLASSES.values()}
        print(f"{region}: {len(rows)} blocks {n}; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
