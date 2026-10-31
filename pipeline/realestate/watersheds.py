"""Micro-watershed per block from the national watershed atlas maps (OpenCity, public domain).

Per L7 block (dataset ``watersheds``):

    mws         the micro-watershed whose boundary holds the block centre (atlas code, e.g. 4D7D7a1)
    watershed   the watershed above it (e.g. 4D7D7)
    mws_id      a number per micro-watershed within the city, for grouping
    mws_km2     area of the whole micro-watershed, km2

Maps: micro-watershed boundaries (Watershed Atlas of India codes: basin, catchment, sub-catchment, watershed,
sub-watershed, micro-watershed) for Bengaluru, Chennai, Delhi, Hyderabad, Kolkata, Mumbai and Pune. Every block of the
region is checked, lived-in or not, so a lens can measure how much of each small catchment is paved over.

    python -m pipeline.realestate.watersheds --region bengaluru,chennai,delhi,hyderabad,kolkata,mumbai,pune
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline.realestate.pincodes import bounds

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
O = "https://data.opencity.in/dataset/"
SOURCES = {
    "bengaluru": O + "bde85eeb-7c7e-431e-b8f0-0c6a7e7bece2/resource/c0dcd393-b1a2-4010-ac8b-8e0d848c2259/download/blr_micro_watersheds.geojson",
    "chennai": O + "11fa0892-9c18-4b7c-a6b5-29b2475eb61a/resource/7b39fba4-7d78-473c-be7d-6f7b1421e992/download/chn_micro_watersheds.geojson",
    "delhi": O + "9b57365a-256f-4de2-845a-ffe22b8cf07b/resource/e055550e-5f7a-46d3-955b-13adb669b1c8/download/del_micro_watersheds.geojson",
    "hyderabad": O + "cf744d8e-a235-4b62-8800-a3957f53dcdf/resource/2b3ba954-875b-482c-8868-218a77474e02/download/hyd_micro_watersheds.geojson",
    "kolkata": O + "e6360adc-99b7-42b8-8c4d-7d6d8ec2bd20/resource/a53210e3-28c3-4154-a104-2152b3889492/download/kol_micro_watersheds.geojson",
    "mumbai": O + "796d101e-3803-40b0-8769-db3a53350011/resource/1ed41abe-497a-4c6d-b771-e2d39ccef965/download/mum_micro_watersheds.geojson",
    "pune": O + "6126853b-7995-470b-9b05-0c29dc03a481/resource/c80ccf3b-baab-4aa4-baae-be8587e10116/download/pune_micro_watersheds.geojson",
}


def micro(doc):
    """[(mws code, watershed code, geometry as MultiPolygon, km2, bounds)]; the atlas AREA is in hectares."""
    out = []
    for f in doc.get("features") or []:
        p, g = f.get("properties") or {}, f.get("geometry") or {}
        code = (p.get("MWS") or "").strip()
        if not code or g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        mp = {"type": "MultiPolygon", "coordinates": [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]}
        try:
            km2 = round(float(p.get("AREA")) / 100, 2)
        except (TypeError, ValueError):
            from pipeline.realestate.pincodes import area_km2
            km2 = round(area_km2(mp), 2)
        out.append((code, (p.get("WATERSHED") or "").strip() or None, mp, km2, bounds(mp)))
    return out


def rows(cells, mws):
    from pipeline.realestate.registration import assign
    got = assign(cells, [(None, None, m[2]) for m in mws])
    ids = {c: k + 1 for k, c in enumerate(sorted({m[0] for m in mws}))}
    return {c: {a: b for a, b in {"mws": mws[k][0], "watershed": mws[k][1], "mws_id": ids[mws[k][0]], "mws_km2": mws[k][3]}.items() if b is not None}
            for c, k in got.items()}


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("mws", "Micro-watershed (atlas code)", type="category", agg="mode"),
        FieldSpec("watershed", "Watershed (atlas code)", type="category", agg="mode"),
        FieldSpec("mws_id", "Micro-watershed number (within the city)", agg="max", unit="", ramp="viridis", higher_is="better"),
        FieldSpec("mws_km2", "Area of the block's micro-watershed", agg="mean", unit="km2", ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="watersheds", title="Micro-watersheds (Watershed Atlas of India)", level=LEVEL, fields=specs, group="Environment",
        description="The micro-watershed and watershed (Watershed Atlas of India codes) whose boundary holds each block, and the "
                    "micro-watershed's area, from the city micro-watershed maps on data.opencity.in.",
        source="pipeline/realestate/watersheds.py (OpenCity micro-watershed maps via DuckDB spatial)",
        license="Public domain (Government of India via data.opencity.in)", default_field="mws_id", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import os

    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.bdalayouts import region_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read <region>.geojson from this folder instead of downloading")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        local = os.path.join(a.from_dir, f"{r}.geojson") if a.from_dir else None
        doc = json.load(open(local)) if local and os.path.exists(local) else requests.get(SOURCES[r], timeout=600).json()
        w, s, e, n = bbox_for(r)
        mws = [m for m in micro(doc) if m[4][0] <= e and m[4][2] >= w and m[4][1] <= n and m[4][3] >= s]
        got = rows(region_cells(r), mws)
        info = cell_dataset(r, got)
        print(f"{r}: {len({v['mws'] for v in got.values()})} micro-watersheds over {len(got)} blocks, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
