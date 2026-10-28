"""Subsidised public canteens from the city maps (OpenCity, public domain).

Per L7 block (dataset ``canteens``):

    canteens   state or municipal subsidised canteens in the block

Maps: Indira Canteens in Bengaluru (KGIS, 2022; meals at ₹5-10), Amma Unavagams in Chennai (GCC, 2023; idli at ₹1)
and Annapurna meal centres in Hyderabad (GHMC, 2018; ₹5 lunch). The lens reads how far residents, and especially those
in mapped slums, walk to one.

    python -m pipeline.realestate.canteens --region bengaluru,chennai,hyderabad
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.firestations import stations
from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {
    "bengaluru": "107ffbf6-8358-47af-aa96-c55bb01da6ea/resource/2548fd52-d157-4b0e-a611-b1b0c15ad89b/download/285c22a8-1497-4d78-87bb-01297ae2f48c.kml",
    "chennai": "4303b9d3-8c8a-49ff-8ac3-9ca371294bc0/resource/f2ce5241-0bd9-4890-bd24-bd87d9fdfbd8/download/e34d8315-2d7a-49dd-8d6a-056af393d048.kml",
    "hyderabad": "f515c4f3-98db-41cd-94df-69c29a50749b/resource/06f75ef4-e066-4b72-995c-ec131d137b73/download/ad354984-c72f-4f48-8139-1a99c29270bb.kml",
}


def cell_dataset(region, pts):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("canteens", "Subsidised public canteens", agg="sum", unit="canteens", ramp="greens", higher_is="better")]
    spec = DatasetSpec(
        id="canteens", title="Subsidised canteens (city maps)", level=LEVEL, fields=specs, group="Real estate",
        description="State and municipal subsidised canteens from the city maps on data.opencity.in, counted per block: Indira "
                    "Canteens (Bengaluru, 2022), Amma Unavagams (Chennai, 2023) and Annapurna meal centres (Hyderabad, 2018).",
        source="pipeline/realestate/canteens.py (OpenCity canteen maps)",
        license="Public domain (KGIS, GCC, GHMC via data.opencity.in)", default_field="canteens", extrude=False)
    recs = ({"lat": lat, "lng": lng, "canteens": 1} for lng, lat in pts)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        pts = stations(kml_points(requests.get(OPENCITY + SOURCES[r], timeout=300).content.decode("utf-8-sig")), bbox_for(r))
        info = cell_dataset(r, pts)
        print(f"{r}: {len(pts)} canteens in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
