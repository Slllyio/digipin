"""Lake buffer zones per block from the official wetland map (Bengaluru Urban, KGIS via OpenCity, public domain).

Per L7 block (dataset ``lake_buffers``):

    lake_pct       share of the block inside a mapped lake or tank (%)
    buffer30_pct   share in the 30 m ring around one (%): the no-build buffer in Bengaluru's zoning regulations
    buffer75_pct   share within 75 m (%, 30 m ring included): the buffer the National Green Tribunal ordered in 2016
                   (stayed by the Supreme Court in 2019), kept as the wider screen

The Karnataka GIS wetland map gives 265 lakes, tanks and other wetlands in Bengaluru Urban as polygons, without names.
Polygons are filled on a ~10 m raster and the rings come from a distance transform.

    python -m pipeline.realestate.lakebuffers
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.ecolimits import Raster, block_shares, fill_polygons, kml_polygons

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PX_M = 10
URL = ("https://data.opencity.in/dataset/69d28d30-b11d-49a7-9ff0-0d4f7d881522/resource/8f61888f-94c0-488f-bbdc-c7b160161458/"
       "download/5b8dca1e-1ded-4ad2-8cd9-3cea2cd0cfbd.kml")
RINGS_M = (30, 75)


def masks(lake, px_m=PX_M):
    """{'lake_pct': lake, 'buffer30_pct': ..., 'buffer75_pct': ...} boolean masks; buffers are land within m of a lake."""
    from scipy import ndimage
    dist = ndimage.distance_transform_edt(~lake) * px_m
    out = {"lake_pct": lake}
    for m in RINGS_M:
        out[f"buffer{m}_pct"] = ~lake & (dist <= m)
    return out


def shares(bbox, text, px_m=PX_M, log=print):
    import numpy as np
    r = Raster(bbox, px_m)
    lake = fill_polygons(r, kml_polygons(text))
    log(f"bengaluru: raster {r.W}x{r.H}, lakes {lake.sum() * px_m ** 2 / 1e6:.1f} km²")
    return block_shares(r, masks(lake, px_m), np.ones_like(lake))


def cell_dataset(region, sh):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("lake_pct", "Share of the block inside a mapped lake or tank", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="better"),
        FieldSpec("buffer30_pct", "Share in the 30 m lake buffer (no-build zone)", agg="mean", unit="%", domain=[0, 50], ramp="reds", higher_is="worse"),
        FieldSpec("buffer75_pct", "Share within 75 m of a lake (NGT 2016 buffer, stayed)", agg="mean", unit="%", domain=[0, 80], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="lake_buffers", title="Lake buffer zones (Bengaluru wetland map)", level=LEVEL, fields=specs, group="Environment",
        description="Share of each block inside a lake or tank on the Karnataka GIS wetland map of Bengaluru Urban (265 "
                    "wetlands), and within 30 m and 75 m of one, via data.opencity.in.",
        source="pipeline/realestate/lakebuffers.py (KGIS wetlands via OpenCity)",
        license="Public domain (Karnataka GIS via data.opencity.in)", default_field="buffer30_pct", extrude=False)
    recs = ({"digipin": c, **v} for c, v in sh.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    text = requests.get(URL, timeout=300).content.decode("utf-8-sig")
    info = cell_dataset("bengaluru", shares(bbox_for("bengaluru"), text))
    print(f"bengaluru: {info['cells']} blocks touch a lake or its buffer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
