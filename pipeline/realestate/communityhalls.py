"""Community halls from GHMC's map for Hyderabad (OpenCity, public domain).

Per L7 block (dataset ``community_halls``):

    halls   GHMC community halls listed in the block

Map: GHMC community halls (2018, 1,375 halls across its six zones). The lens loader tops up
``places.community_centres`` with whichever source lists more per block, so the cooling-centre lens sees them.

    python -m pipeline.realestate.communityhalls
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.firestations import stations
from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/58c2db1a-98fa-4363-b360-271f1d532aba/resource/2101e7c4-311d-4b9b-a8ef-0517ab8f9795/"
       "download/434591c8-2ced-44c7-b147-eef59428f4c3.kml")


def cell_dataset(region, pts):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("halls", "Community halls (GHMC list)", agg="sum", unit="halls", ramp="blues", higher_is="better")]
    spec = DatasetSpec(
        id="community_halls", title="Community halls (GHMC map)", level=LEVEL, fields=specs, group="Real estate",
        description="GHMC community halls in Hyderabad (2018) from data.opencity.in, counted per block. Tops up the "
                    "OpenStreetMap/Overture community centre counts.",
        source="pipeline/realestate/communityhalls.py (OpenCity GHMC community halls map)",
        license="Public domain (GHMC via data.opencity.in)", default_field="halls", extrude=False)
    recs = ({"lat": lat, "lng": lng, "halls": 1} for lng, lat in pts)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline._lib.regions import bbox_for
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    pts = stations(kml_points(requests.get(URL, timeout=300).content.decode("utf-8-sig")), bbox_for("hyderabad"))
    info = cell_dataset("hyderabad", pts)
    print(f"hyderabad: {len(pts)} community halls in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
