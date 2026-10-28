"""Corporation parks, playgrounds and layout open spaces per block (Hyderabad, Pune, Mumbai; OpenCity, public domain).

Per L7 block (dataset ``parks_official``):

    parks         parks and gardens on the corporation's list
    playgrounds   playgrounds (GHMC, Hyderabad)
    open_spaces   open spaces left in approved layouts (GHMC 2018, Hyderabad): land reserved for public use that is
                  not a developed park
    park_m2       garden area from the mapped outline (PMC, Pune)
    in_area       1 inside Mumbai Police's jurisdiction map, which matches the BMC area the garden map covers, so
                  Thane and Mira-Bhayandar are not read as park gaps

Maps: GHMC parks (823), playgrounds (488) and layout open spaces (1,355), September 2018; PMC parks and gardens (198
outlines); BMC public gardens, parks, recreation and play grounds, Miyawaki gardens and zoos (990; names with "P.G.",
"playground" or "maidan" count as playgrounds).

    python -m pipeline.realestate.parksofficial --region hyderabad,pune,mumbai
"""
from __future__ import annotations

import argparse
import math
import re
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
    "mumbai": [
        ("parks", OPENCITY + "c7e1a0bf-ac1f-42c3-bd86-a6b272176858/resource/8267750f-1710-44b1-87d9-e88209f1eeee/download/26922e2f-6c2a-4e99-b2a6-59318c5f9d83.kml"),
    ],
}
PLAY = re.compile(r"\bp\.\s?g\.|play ?ground|maidan", re.I)


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
    for lng, lat, p in kml_points(text):
        k = (round(lng, 4), round(lat, 4))
        if not (60 < lng < 100 and 5 < lat < 40) or k in seen:
            continue
        seen.add(k)
        name = p.get("NAME") or p.get("Assessor_Address") or ""
        yield {"lat": lat, "lng": lng, ("playgrounds" if kind == "parks" and PLAY.search(name) else kind): 1}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("parks", "Parks and gardens (corporation list)", agg="sum", unit="parks", ramp="greens", higher_is="better"),
        FieldSpec("playgrounds", "Playgrounds (GHMC)", agg="sum", unit="playgrounds", ramp="greens", higher_is="better"),
        FieldSpec("open_spaces", "Layout open spaces (GHMC 2018)", agg="sum", unit="open spaces", ramp="greens", higher_is="better"),
        FieldSpec("park_m2", "Garden area (PMC outlines)", agg="sum", unit="m²", ramp="greens", higher_is="better"),
        FieldSpec("in_area", "Inside the area the corporation's map covers (Mumbai)", agg="max", unit="", domain=[0, 1], ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="parks_official", title="Parks, playgrounds and open spaces (corporation maps)", level=LEVEL, fields=specs, group="Environment",
        description="Parks, playgrounds and layout open spaces from the corporations' own maps on data.opencity.in, counted per "
                    "block: GHMC parks, playgrounds and open spaces left in approved layouts (Hyderabad, 2018) and PMC parks "
                    "and gardens with their outlines (Pune), and BMC gardens, parks, play grounds and zoos (Mumbai).",
        source="pipeline/realestate/parksofficial.py (OpenCity park maps)",
        license="Public domain (GHMC, PMC and BMC via data.opencity.in)", default_field="parks", extrude=False)
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
            print(f"{r}: {len(got)} from the {kind} map ({sum('playgrounds' in x for x in got)} playgrounds)")
            recs += got
        if r == "mumbai":
            from pipeline.realestate.police import jurisdiction_cells
            recs += [{"digipin": c, "in_area": 1} for c in jurisdiction_cells(r) or []]
        info = cell_dataset(r, recs)
        print(f"{r}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
