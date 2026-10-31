"""Public libraries from the city and state library maps (OpenCity, public domain).

Per L7 block (dataset ``libraries_official``):

    libraries   public libraries listed in the block

Maps: Pune libraries (56, PMC and city listings) and Karnataka Department of Public Libraries' Bengaluru map (115,
2020). The lens loader tops up ``places.libraries`` with whichever source lists more per block.

    python -m pipeline.realestate.libraries --region pune,bengaluru
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
    "pune": "d6df18d8-7762-4dd7-9900-558bd12822ff/resource/7d15eb1e-8f4c-4b23-9553-9a45985d5000/download/3121d40a-a37e-4936-86ce-c1872bf9446c.kml",
    "bengaluru": "000e3a33-a0fd-41a2-9f55-78171c99a44f/resource/eac72477-22a4-4e8f-b7b2-1d488bbdcc32/download/40839757-9521-4766-b8c0-9309cd9da1b0.kml",
}


def cell_dataset(region, pts):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("libraries", "Public libraries (official list)", agg="sum", unit="libraries", ramp="blues", higher_is="better")]
    spec = DatasetSpec(
        id="libraries_official", title="Public libraries (official maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Public libraries from the library maps on data.opencity.in, counted per block: Pune's library list and the "
                    "Karnataka Department of Public Libraries' Bengaluru map (2020). Tops up the OpenStreetMap/Overture library counts.",
        source="pipeline/realestate/libraries.py (OpenCity library maps)",
        license="Public domain (via data.opencity.in)", default_field="libraries", extrude=False)
    recs = ({"lat": lat, "lng": lng, "libraries": 1} for lng, lat in pts)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        text = requests.get(OPENCITY + SOURCES[r], timeout=300).content.decode("utf-8-sig")
        pts = stations(kml_points(text), bbox_for(r))
        info = cell_dataset(r, pts)
        print(f"{r}: {len(pts)} libraries in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
