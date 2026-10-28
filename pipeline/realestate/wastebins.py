"""Public waste bins from the corporations' maps (OpenCity, public domain).

Per L7 block (dataset ``waste_bins``):

    bins   public waste bins or dumper bins the corporation lists in the block

Maps: GCC street bins (Chennai, 2022, about 11,000) and GHMC dumper bins (Hyderabad, 2018, about 2,900; GHMC has since
removed many under its bin-free drive). Repeats within ~10 m count once.

    python -m pipeline.realestate.wastebins --region chennai,hyderabad
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {
    "chennai": "1947e83b-3051-4166-b061-a63c24b51e95/resource/5a9563bc-eef4-41ac-9c95-c83ed6fe242f/download/66542a70-cf1b-47b0-a831-25632321461e.kml",
    "hyderabad": "924d2fa8-bc33-4127-8464-c4d54a3f44d1/resource/1547c1c0-65a6-451c-8c9e-4fbf2438e630/download/603eb42a-a7c1-48d1-ad94-dec026a46df5.kml",
}


def records(points, bbox):
    seen = set()
    for lng, lat, _ in points:
        if not (bbox[0] <= lng <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        k = (round(lng, 4), round(lat, 4))
        if k in seen:
            continue
        seen.add(k)
        yield {"lat": lat, "lng": lng, "bins": 1}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("bins", "Public waste bins (corporation list)", agg="sum", unit="bins", ramp="greens", higher_is="better")]
    spec = DatasetSpec(
        id="waste_bins", title="Public waste bins (corporation maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Public waste bins from the corporations' maps on data.opencity.in, counted per block: GCC street bins (Chennai, "
                    "2022) and GHMC dumper bins (Hyderabad, 2018).",
        source="pipeline/realestate/wastebins.py (OpenCity bin maps)",
        license="Public domain (GCC, GHMC via data.opencity.in)", default_field="bins", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        recs = list(records(kml_points(requests.get(OPENCITY + SOURCES[r], timeout=300).content.decode("utf-8-sig")), bbox_for(r)))
        info = cell_dataset(r, recs)
        print(f"{r}: {len(recs)} bins in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
