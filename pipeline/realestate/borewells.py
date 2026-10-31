"""Public borewells from BWSSB's map for Bengaluru (OpenCity, public domain).

Per L7 block (dataset ``borewells``):

    borewells   BWSSB public borewells listed in the block

Map: BWSSB borewells (KGIS; 7,438 wells, mostly in the 110 villages added to the city in 2007 where Cauvery pipes
arrived late). Repeats within ~10 m count once.

    python -m pipeline.realestate.borewells
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/fa32e4a6-9914-4d66-91d3-0b6cf1802a55/resource/1dc4bb15-ecd4-4322-a3de-9f7f1d2a79cf/"
       "download/9f272fda-9dc3-471e-9619-c456fd1e4ab3.kml")


def records(points):
    seen = set()
    for lng, lat, _ in points:
        if not (77 < lng < 78.2 and 12.5 < lat < 13.5):
            continue
        k = (round(lng, 4), round(lat, 4))
        if k in seen:
            continue
        seen.add(k)
        yield {"lat": lat, "lng": lng, "borewells": 1}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("borewells", "BWSSB public borewells", agg="sum", unit="wells", ramp="blues", higher_is="better")]
    spec = DatasetSpec(
        id="borewells", title="Public borewells (BWSSB map)", level=LEVEL, fields=specs, group="Real estate",
        description="BWSSB's public borewells in Bengaluru (KGIS) from data.opencity.in, counted per block.",
        source="pipeline/realestate/borewells.py (OpenCity BWSSB borewell map)",
        license="Public domain (BWSSB via data.opencity.in)", default_field="borewells", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    recs = list(records(kml_points(requests.get(URL, timeout=300).content.decode("utf-8-sig"))))
    info = cell_dataset("bengaluru", recs)
    print(f"bengaluru: {len(recs)} borewells in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
