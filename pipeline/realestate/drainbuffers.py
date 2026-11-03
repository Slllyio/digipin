"""Storm-water drain buffers per block from BBMP's 2022 drain maps (Bengaluru; OpenCity, public domain).

Per L7 block (dataset ``drain_buffers``):

    primary_m      primary storm-water drain (rajakaluve) length in the block
    secondary_m    secondary drain length
    tertiary_m     tertiary drain length
    buffer_pct     share of the block in the drain buffer of the Revised Master Plan 2015 zoning regulations (%):
                   50 m from the centre of a primary drain, 25 m from a secondary, 15 m from a tertiary
    buffer_ngt_pct share in the wider buffer the National Green Tribunal ordered in 2016 (50, 35 and 25 m; set aside
                   by the Supreme Court in 2019), kept as a screen

The maps are drain centrelines; each class is drawn on a ~10 m raster and the buffers come from distance transforms.

    python -m pipeline.realestate.drainbuffers
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from pipeline.realestate.ecolimits import Raster, block_shares, walls
from pipeline.realestate.sewers import pieces

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PX_M = 10
B = "https://data.opencity.in/dataset/fc97e05c-c54b-44e9-8d98-7663ee887922/resource/"
SOURCES = {
    "primary": B + "114758e9-c356-46e0-afdb-e1d52f972863/download/03eea514-d4bf-4cd9-8c7b-f904b1ea83f2.kml",
    "secondary": B + "4b26cd1b-7956-418d-92e4-35275caf547a/download/7033efa5-2382-4e4a-8884-5715698eac71.kml",
    "tertiary": B + "aa20362c-9769-46dc-9a88-c100504f6d4e/download/79494624-2682-4f31-a0e5-2fa26b867304.kml",
}
RMP_M = {"primary": 50, "secondary": 25, "tertiary": 15}
NGT_M = {"primary": 50, "secondary": 35, "tertiary": 25}
LINE = re.compile(r"<LineString>.*?<coordinates>\s*([^<]+?)\s*</coordinates>", re.S)


def lines(text):
    """[(lng, lat), ...] for every LineString in a KML, whatever tags sit between it and its coordinates."""
    for m in LINE.finditer(text):
        pts = [tuple(map(float, p.split(",")[:2])) for p in m.group(1).split()]
        if len(pts) >= 2:
            yield pts


def buffers(walls_by_class, px_m=PX_M):
    """{'buffer_pct', 'buffer_ngt_pct'} boolean masks from {class: centreline mask}."""
    from scipy import ndimage
    rmp = ngt = None
    for k, w in walls_by_class.items():
        if not w.any():
            continue
        d = ndimage.distance_transform_edt(~w) * px_m
        a, b = d <= RMP_M[k], d <= NGT_M[k]
        rmp = a if rmp is None else rmp | a
        ngt = b if ngt is None else ngt | b
    return {"buffer_pct": rmp, "buffer_ngt_pct": ngt}


def length_records(kind, polylines):
    for pts in polylines:
        for lat, lng, m in pieces(pts):
            yield {"lat": lat, "lng": lng, f"{kind}_m": m}


def shares(bbox, by_class, px_m=PX_M, log=print):
    import numpy as np
    r = Raster(bbox, px_m)
    w = {k: walls(r, v) for k, v in by_class.items()}
    m = buffers(w, px_m)
    log(f"bengaluru: raster {r.W}x{r.H}, drain buffer {m['buffer_pct'].sum() * px_m ** 2 / 1e6:.1f} km² (RMP), "
        f"{m['buffer_ngt_pct'].sum() * px_m ** 2 / 1e6:.1f} km² (NGT)")
    return block_shares(r, m, np.ones_like(m["buffer_pct"]))


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("primary_m", "Primary storm-water drain (rajakaluve) length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("secondary_m", "Secondary storm-water drain length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("tertiary_m", "Tertiary storm-water drain length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("buffer_pct", "Share in the RMP 2015 drain buffer (50/25/15 m)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("buffer_ngt_pct", "Share in the NGT 2016 drain buffer (50/35/25 m, set aside)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="drain_buffers", title="Storm-water drain buffers (BBMP drain maps)", level=LEVEL, fields=specs, group="Environment",
        description="BBMP's 2022 primary, secondary and tertiary storm-water drain maps for Bengaluru via data.opencity.in: "
                    "drain length per block and the share of the block in the Revised Master Plan 2015 drain buffer "
                    "(50, 25 and 15 m from the centre) and the wider NGT 2016 buffer.",
        source="pipeline/realestate/drainbuffers.py (BBMP storm-water drain maps via OpenCity)",
        license="Public domain (BBMP via data.opencity.in)", default_field="buffer_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    by_class = {k: list(lines(requests.get(u, timeout=600).content.decode("utf-8-sig"))) for k, u in SOURCES.items()}
    print("bengaluru: " + ", ".join(f"{len(v)} {k} lines" for k, v in by_class.items()))
    recs = [{"digipin": c, **v} for c, v in shares(bbox_for("bengaluru"), by_class).items()]
    for k, v in by_class.items():
        recs += list(length_records(k, v))
    info = cell_dataset("bengaluru", recs)
    print(f"bengaluru: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
