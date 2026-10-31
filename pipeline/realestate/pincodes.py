"""Postal pincode per block from India Post's 2025 pincode boundary map (OpenCity, public domain).

Per L7 block (dataset ``pincodes``):

    pincode    the six-digit pincode whose boundary holds the block centre
    office     the head or sub post office the pincode is named after
    division   the postal division running it
    pin_km2    area of the whole pincode, km2: how coarse an address the pincode alone gives

Map: the all-India pincode boundaries (19,312 pincodes) India Post published in May 2025. Only lived-in blocks (those
with a population estimate) get a pincode; a block whose centre falls in a gap between boundaries has none.

    python -m pipeline.realestate.pincodes --region delhi,mumbai
"""
from __future__ import annotations

import argparse
import math
import os
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/a85a2a89-24bb-4b35-8914-c8d77b23f473/resource/962ca587-6a88-4ee2-89f5-14a20aa3a183/"
       "download/dd7bfd69-143e-462b-bfa3-2ac35d931342.kmz")
REGIONS = ("ahmedabad", "bengaluru", "bhopal", "chennai", "delhi", "guna", "hyderabad", "jaipur", "kolkata", "lucknow", "mumbai", "pune")


def clean(s):
    return " ".join((s or "").split()) or None


def ring_km2(ring):
    """Area of a lng/lat ring in km2 (local equirectangular projection; fine at pincode size)."""
    if len(ring) < 3:
        return 0.0
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    kx, ky = 111.32 * math.cos(lat0), 110.57
    a = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))
    return abs(a) / 2 * kx * ky


def area_km2(geom):
    return sum(max(ring_km2(rings[0]) - sum(ring_km2(h) for h in rings[1:]), 0.0) for rings in geom["coordinates"] if rings)


def bounds(geom):
    xs = [p[0] for rings in geom["coordinates"] for p in rings[0]]
    ys = [p[1] for rings in geom["coordinates"] for p in rings[0]]
    return min(xs), min(ys), max(xs), max(ys)


def pins(text):
    """[(pincode, office, division, geometry, km2, bounds)] per boundary in the map."""
    from pipeline.realestate.wards import kml_features
    out = []
    for f in kml_features(text):
        p = f["properties"]
        try:
            pin = int(p.get("Pincode"))
        except (TypeError, ValueError):
            continue
        g = f["geometry"]
        out.append((pin, clean(p.get("Office_Name")), clean(p.get("Division")), g, round(area_km2(g), 2), bounds(g)))
    return out


def rows(cells, juris):
    from pipeline.realestate.registration import assign
    got = assign(cells, [(None, None, j[3]) for j in juris])
    return {c: {"pincode": juris[k][0], "office": juris[k][1], "division": juris[k][2], "pin_km2": juris[k][4]} for c, k in got.items()}


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("pincode", "Postal pincode", agg="max", unit="", ramp="viridis", higher_is="better"),
        FieldSpec("office", "Post office the pincode is named after", type="category", agg="mode"),
        FieldSpec("division", "Postal division", type="category", agg="mode"),
        FieldSpec("pin_km2", "Area of the block's pincode", agg="mean", unit="km2", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="pincodes", title="Postal pincodes (India Post 2025 boundaries)", level=LEVEL, fields=specs, group="Real estate",
        description="The pincode whose 2025 India Post boundary holds each lived-in block, the post office and postal division "
                    "behind it and the pincode's whole area, from the all-India pincode map on data.opencity.in.",
        source="pipeline/realestate/pincodes.py (OpenCity India Pincode Maps 2025 via DuckDB spatial)",
        license="Public domain (India Post via data.opencity.in)", default_field="pin_km2", extrude=False)
    recs = [{"digipin": c, **{a: b for a, b in r.items() if b is not None}} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def read_map(path):
    import zipfile
    with zipfile.ZipFile(path) as z:
        return z.read(next(n for n in z.namelist() if n.endswith(".kml"))).decode("utf-8-sig")


def main(argv=None):
    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.powerplants import lived_cells
    from pipeline.realestate.sewers import download
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(REGIONS))
    ap.add_argument("--map", help="the downloaded KMZ (fetched when left out)")
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        src = a.map or os.path.join(tmp, "pincodes.kmz")
        if not os.path.exists(src):
            download(URL, src)
        allpins = pins(read_map(src))
    for r in a.region.split(","):
        w, s, e, n = bbox_for(r)
        near = [p for p in allpins if p[5][0] <= e and p[5][2] >= w and p[5][1] <= n and p[5][3] >= s]
        got = rows(lived_cells(r), near)
        info = cell_dataset(r, got)
        print(f"{r}: {len({v['pincode'] for v in got.values()})} pincodes over {len(got)} blocks, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
