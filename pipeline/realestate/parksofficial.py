"""Corporation parks, playgrounds and layout open spaces per block (Hyderabad, Pune; OpenCity, public domain).

Per L7 block (dataset ``parks_official``):

    parks         parks and gardens on the corporation's list
    playgrounds   playgrounds (GHMC, Hyderabad)
    open_spaces   open spaces left in approved layouts (GHMC 2018, Hyderabad): land reserved for public use that is
                  not a developed park
    park_m2       garden area from the mapped outline (PMC, Pune)

Maps: GHMC parks (823), playgrounds (488) and layout open spaces (1,355), September 2018; PMC parks and gardens (198
outlines).

    python -m pipeline.realestate.parksofficial --region hyderabad,pune
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from pipeline.realestate.ecolimits import kml_polygons
from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
GHMC = OPENCITY + "3b4ea5b4-1adc-4f40-9e7f-18d11c367950/resource/"
SOURCES = {
    "hyderabad": [
        ("parks", GHMC + "5a009fdd-ad60-4331-9f86-1f94116130bf/download/5153c44b-f2b6-426a-9860-25559ba0b392.kml"),
        ("playgrounds", GHMC + "03771a56-1e67-4637-a522-292ccfdf837d/download/e8738762-5472-4118-a7fe-8c94ee81f962.kml"),
        ("open_spaces", GHMC + "f579e60e-952a-4d88-8905-db8fb57fd567/download/56461043-4d6e-4e31-9138-e7d271d1378e.kml"),
    ],
    "pune": [
        ("parks", OPENCITY + "c6332bb9-b70c-4320-823f-4f454dbf676c/resource/101fe35c-5190-47c9-bf1d-7c0d806c47a1/download/bbbd1d45-23fd-442c-8b1d-6fc48a1064a0.kml"),
    ],
}


def ring_area_m2(ring):
    """Area of a lng/lat ring in m² (shoelace on a local equirectangular projection)."""
    if len(ring) < 3:
        return 0.0
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    kx, ky = 111_320 * math.cos(lat0), 110_574
    xy = [(p[0] * kx, p[1] * ky) for p in ring]
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(xy, xy[1:] + xy[:1]))) / 2


def centroid(ring):
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def records(kind, text):
    seen = set()
    if "<Polygon" in text:
        for outer, holes in kml_polygons(text):
            if len(outer) < 3:
                continue
            lng, lat = centroid(outer)
            area = ring_area_m2(outer) - sum(ring_area_m2(h) for h in holes)
            yield {"lat": lat, "lng": lng, kind: 1, "park_m2": round(area)}
        return
    for lng, lat, _ in kml_points(text):
        k = (round(lng, 4), round(lat, 4))
        if not (60 < lng < 100 and 5 < lat < 40) or k in seen:
            continue
        seen.add(k)
        yield {"lat": lat, "lng": lng, kind: 1}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("parks", "Parks and gardens (corporation list)", agg="sum", unit="parks", ramp="greens", higher_is="better"),
        FieldSpec("playgrounds", "Playgrounds (GHMC)", agg="sum", unit="playgrounds", ramp="greens", higher_is="better"),
        FieldSpec("open_spaces", "Layout open spaces (GHMC 2018)", agg="sum", unit="open spaces", ramp="greens", higher_is="better"),
        FieldSpec("park_m2", "Garden area (PMC outlines)", agg="sum", unit="m²", ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="parks_official", title="Parks, playgrounds and open spaces (corporation maps)", level=LEVEL, fields=specs, group="Environment",
        description="Parks, playgrounds and layout open spaces from the corporations' own maps on data.opencity.in, counted per "
                    "block: GHMC parks, playgrounds and open spaces left in approved layouts (Hyderabad, 2018) and PMC parks "
                    "and gardens with their outlines (Pune).",
        source="pipeline/realestate/parksofficial.py (OpenCity park maps)",
        license="Public domain (GHMC and PMC via data.opencity.in)", default_field="parks", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        recs = []
        for kind, url in SOURCES[r]:
            got = list(records(kind, requests.get(url, timeout=300).content.decode("utf-8-sig")))
            print(f"{r}: {len(got)} {kind}")
            recs += got
        info = cell_dataset(r, recs)
        print(f"{r}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
