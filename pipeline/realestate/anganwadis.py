"""Anganwadi (ICDS) centres per block from the state and city maps on OpenCity (public domain).

Dataset ``anganwadis`` (L7): ``centres``, anganwadi centres in the block. Anganwadis give children under six
supplementary nutrition, pre-school and immunisation, and pregnant and nursing mothers their take-home rations, so
walking distance matters. Maps: Telangana (KGIS-style state map, used for the Hyderabad region), Karnataka (KGIS,
for Bengaluru) and Greater Chennai (ICDS 2023). Points are clipped to the region's box.

    python -m pipeline.realestate.anganwadis --region hyderabad,bengaluru,chennai
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {
    "hyderabad": ("d72a05e5-e852-4b6c-8b73-d71e4903c481/resource/d389598a-2fbc-4a5f-a009-79ab8716861b/download/20ec548f-a099-48cb-b004-ce245d466f70.kml", "Telangana anganwadis map"),
    "bengaluru": ("6c07f631-febe-4dc5-81a8-97e25c4a6e7c/resource/09608dde-a38b-476a-9ef4-03f381b14898/download/3694a31d-f5c4-4248-acde-0ea068412db2.kml", "Karnataka anganwadis map (KGIS)"),
    "chennai": ("749e40f1-12b3-4b07-a06a-2b87c025883d/resource/8a9af113-d581-4c27-b76f-f9aa0776d38c/download/6e6ccf92-e0ee-42e1-9351-625f782d4dd8.kml", "Chennai anganwadis map 2023"),
}


def records(points, box):
    w, s, e, n = box
    seen = set()
    for lng, lat, _ in points:
        if not (w <= lng <= e and s <= lat <= n):
            continue
        k = (round(lng, 5), round(lat, 5))
        if k in seen:
            continue
        seen.add(k)
        yield {"lat": lat, "lng": lng, "centres": 1}


def run(region):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.toilets import kml_points
    path, _ = SOURCES[region]
    pts = kml_points(requests.get(OPENCITY + path, timeout=600).content.decode("utf-8-sig"))
    specs = [FieldSpec("centres", "Anganwadi centres", agg="sum", unit="centres", ramp="greens", higher_is="better")]
    names = "; ".join(f"{r}: {n}" for r, (_, n) in SOURCES.items())
    spec = DatasetSpec(
        id="anganwadis", title="Anganwadi centres (ICDS, OpenCity)", level=LEVEL, fields=specs, group="Real estate",
        description="Anganwadi (Integrated Child Development Services) centres per block from the state and city maps on "
                    f"data.opencity.in ({names}). Duplicate points dropped.",
        source="pipeline/realestate/anganwadis.py (OpenCity anganwadi maps)", license="Public domain (data.opencity.in)",
        default_field="centres", extrude=False)
    info = store.write_dataset(CELLS, spec, region, store.bin_records(records(pts, bbox_for(region)), LEVEL, specs), parquet=False)
    return len(pts), info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        n, info = run(r)
        print(f"{r}: {n} centres on the map, {info['cells']} blocks in the region")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
