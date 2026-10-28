"""Piped water supply lines per block from BWSSB's network maps for Bengaluru (OpenCity, public domain).

Per L7 block (dataset ``water_lines``):

    pipe_m     water supply line length in the block, all diameters
    main_m     of it, mains wider than 300 mm
    in_area    1 where the corporation's ward map (``wards`` dataset) holds the block

Maps: BWSSB's detailed water supply line maps, lines of 300 mm or less (about 98,000 lines, 10,800 km) and lines wider
than 300 mm (about 2,900 lines, 940 km). Lines are cut into pieces of at most 25 m placed at their midpoints
(``sewers.pieces``).

    python -m pipeline.realestate.waterlines
"""
from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

from pipeline.realestate.sewers import LINE, corporation_cells, download, pieces, read_kml

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
B = "https://data.opencity.in/dataset/97e5e83e-3c77-4de1-9221-97a3ab1f7784/resource/"
SOURCES = {
    "bengaluru": [
        (B + "439d1c8b-aa78-4f5a-917c-62b3d6db77b0/download/4f999482-f969-484e-9209-64e54fba9055.kml", False),
        (B + "6c3e5957-82bf-4922-8513-b3ee622f1125/download/f6c32921-8975-44d3-9b55-2174396e0991.kml", True),
    ],
}


def records(text, main):
    for m in LINE.finditer(text):
        pts = [tuple(map(float, p.split(",")[:2])) for p in m.group(1).split()]
        for lat, lng, length in pieces(pts) if len(pts) >= 2 else ():
            r = {"lat": lat, "lng": lng, "pipe_m": length}
            if main:
                r["main_m"] = length
            yield r


def cell_dataset(region, recs, area=None):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("pipe_m", "Water supply line length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("main_m", "Water mains wider than 300 mm", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("in_area", "Inside the municipal corporation's wards", agg="max", unit="", domain=[0, 1], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="water_lines", title="Piped water supply lines (BWSSB maps)", level=LEVEL, fields=specs, group="Real estate",
        description="BWSSB's detailed water supply line maps for Bengaluru on data.opencity.in: water line length per block, "
                    "all diameters, and mains wider than 300 mm.",
        source="pipeline/realestate/waterlines.py (OpenCity BWSSB water supply line maps)",
        license="Public domain (BWSSB via data.opencity.in)", default_field="pipe_m", extrude=False)
    recs = list(recs) + [{"digipin": c, "in_area": 1} for c in area or ()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    for region in a.region.split(","):
        recs = []
        with tempfile.TemporaryDirectory() as tmp:
            for url, main_line in SOURCES[region]:
                src = os.path.join(a.from_dir or tmp, url.rsplit("/", 1)[-1])
                if not os.path.exists(src):
                    download(url, src)
                recs += list(records(read_kml(src), main_line))
        info = cell_dataset(region, recs, corporation_cells(region))
        print(f"{region}: {sum(r['pipe_m'] for r in recs) / 1000:.0f} km of water line "
              f"({sum(r.get('main_m', 0) for r in recs) / 1000:.0f} km of mains) in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
