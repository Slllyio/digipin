"""Lake buffer zones per block from official lake maps (Bengaluru KGIS wetlands, Hyderabad GHMC tanks; OpenCity, public domain).

Per L7 block (dataset ``lake_buffers``):

    lake_pct       share of the block inside a mapped lake or tank (%)
    buffer30_pct   share in the statutory no-build buffer (%): 30 m in Bengaluru's zoning regulations; in Hyderabad
                   30 m round tanks of 10 ha or more and 9 m round smaller ones (GO Ms 168, 2012)
    buffer75_pct   share within 75 m (%, 30 m ring included): the buffer the National Green Tribunal ordered in 2016
                   (set aside by the Supreme Court in 2019), kept as the wider screen

The Karnataka GIS wetland map gives 265 lakes, tanks and other wetlands in Bengaluru Urban as polygons, without names;
GHMC's land-use map gives Hyderabad's reservoirs and tanks. Polygons are filled on a ~10 m raster and the buffers come
from distance transforms.

    python -m pipeline.realestate.lakebuffers --region bengaluru,hyderabad
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
HYD_TANKS = ("https://data.opencity.in/dataset/4becf994-e7f5-4da3-b201-b56b126b57f7/resource/24d7e2e8-74bf-4ba3-bf7c-0867848f74d9/"
             "download/9e2e8554-6052-4df3-a8c0-94c993658cc5.kml")
SOURCES = {"bengaluru": URL, "hyderabad": HYD_TANKS}
RINGS_M = (30, 75)
BIG_HA, SMALL_M = 10, 9     # GO Ms 168: 30 m round tanks of 10 ha or more, 9 m round smaller ones (Hyderabad)


def masks(lake, px_m=PX_M, small=None):
    """{'lake_pct', 'buffer30_pct', 'buffer75_pct'} boolean masks; buffers are land within m of a lake. With ``small``
    (lakes under BIG_HA), the statutory buffer round those is SMALL_M instead of 30 m."""
    from scipy import ndimage
    every = lake if small is None else lake | small
    dist = ndimage.distance_transform_edt(~every) * px_m
    out = {"lake_pct": every}
    for m in RINGS_M:
        out[f"buffer{m}_pct"] = ~every & (dist <= m)
    if small is not None:
        big = ndimage.distance_transform_edt(~lake) * px_m if lake.any() else dist * 0 + 1e9
        # The 9 m band is under one pixel wide: count the pixels next to the shore (centre within SMALL_M + half a pixel).
        out["buffer30_pct"] = ~every & ((big <= RINGS_M[0]) | (dist <= SMALL_M + px_m / 2))
    return out


def shares(region, bbox, text, px_m=PX_M, log=print):
    import numpy as np

    from pipeline.realestate.parksofficial import ring_area_m2
    r = Raster(bbox, px_m)
    polys = kml_polygons(text)
    if region == "hyderabad":
        big = [p for p in polys if ring_area_m2(p[0]) >= BIG_HA * 10_000]
        small = [p for p in polys if ring_area_m2(p[0]) < BIG_HA * 10_000]
        lake, little = fill_polygons(r, big), fill_polygons(r, small)
        log(f"{region}: {len(big)} tanks of {BIG_HA} ha or more, {len(small)} smaller")
    else:
        lake, little = fill_polygons(r, polys), None
    log(f"{region}: raster {r.W}x{r.H}, lakes {(lake if little is None else lake | little).sum() * px_m ** 2 / 1e6:.1f} km²")
    return block_shares(r, masks(lake, px_m, little), np.ones_like(lake))


def cell_dataset(region, sh):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("lake_pct", "Share of the block inside a mapped lake or tank", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="better"),
        FieldSpec("buffer30_pct", "Share in the statutory lake buffer (30 m; 9 m round Hyderabad tanks under 10 ha)", agg="mean", unit="%", domain=[0, 50], ramp="reds", higher_is="worse"),
        FieldSpec("buffer75_pct", "Share within 75 m of a lake (NGT 2016 buffer, set aside)", agg="mean", unit="%", domain=[0, 80], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="lake_buffers", title="Lake buffer zones (official lake maps)", level=LEVEL, fields=specs, group="Environment",
        description="Share of each block inside a lake or tank, in its statutory no-build buffer and within 75 m of one: "
                    "the Karnataka GIS wetland map of Bengaluru Urban (265 wetlands) and GHMC's reservoirs and tanks for "
                    "Hyderabad, via data.opencity.in.",
        source="pipeline/realestate/lakebuffers.py (KGIS wetlands and GHMC tanks via OpenCity)",
        license="Public domain (Karnataka GIS and GHMC via data.opencity.in)", default_field="buffer30_pct", extrude=False)
    recs = ({"digipin": c, **v} for c, v in sh.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for reg in a.region.split(","):
        text = requests.get(SOURCES[reg], timeout=300).content.decode("utf-8-sig")
        info = cell_dataset(reg, shares(reg, bbox_for(reg), text))
        print(f"{reg}: {info['cells']} blocks touch a lake or its buffer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
