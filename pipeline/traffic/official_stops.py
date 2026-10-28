"""Bus stops from the operators' own stop lists (OpenCity, public domain), per L7 block.

OpenStreetMap maps only part of the bus network (about 2,000 of BEST's 6,000 Mumbai stops, 600 of PMPML's 5,600 in
Pune). Dataset ``bus_stops_official`` counts the operators' stops per block; the urban lenses take, per block, the larger
of this count and OpenStreetMap's, so transit access, bus gaps and feeder lenses see the whole network.

    mumbai   BEST bus stops and depots map
    pune     PMPML bus stops (GTFS stop list)
    chennai  GCC bus shelters (shelters, so a lower bound on stops)

    python -m pipeline.traffic.official_stops --region mumbai,pune,chennai
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {
    "mumbai": ("c2a2de1e-a017-4fb9-9e46-de6fbfbb393b/resource/514eadc2-7fa8-4749-87e5-ebe486487f09/download/b34111da-5b73-45e9-82d0-78da9d153b1c.kml", "BEST stops and depots"),
    "pune": ("30dd0c51-61d4-4085-99ab-9a8aec97b329/resource/2c43a9a6-9a58-48dd-8891-e5f3dbe9120c/download/46c96db4-af62-4b84-a479-5a0279a8f44a.kml", "PMPML bus stops"),
    "chennai": ("fc4c6937-2927-4c9c-939b-ac77af811aa7/resource/b1710404-a6e5-4311-ba38-3805a00e36ce/download/6e6ba0e8-8ddd-44b4-84b3-2d672559bf2f.kml", "GCC bus shelters"),
}


def records(points):
    seen = set()
    for lng, lat, _ in points:
        if not (60 < lng < 100 and 5 < lat < 40):
            continue
        k = (round(lng, 5), round(lat, 5))         # some lists repeat a stop once per direction or route
        if k in seen:
            continue
        seen.add(k)
        yield {"lat": lat, "lng": lng, "stops": 1}


def run(region):
    import requests

    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.toilets import kml_points
    path, _ = SOURCES[region]
    pts = kml_points(requests.get(OPENCITY + path, timeout=300).content.decode("utf-8-sig"))
    specs = [FieldSpec("stops", "Bus stops (operator list)", agg="sum", unit="stops", ramp="viridis", higher_is="better")]
    names = "; ".join(f"{r}: {n}" for r, (_, n) in SOURCES.items())
    spec = DatasetSpec(
        id="bus_stops_official", title="Bus stops (operator lists)", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Bus stops from the operators' own lists on data.opencity.in, counted per block (duplicate points dropped). "
                    f"Lenses use the larger of this and OpenStreetMap's count per block. Sources: {names}.",
        source="pipeline/traffic/official_stops.py (OpenCity)", license="Public domain (BEST, PMPML, GCC via data.opencity.in)",
        default_field="stops", extrude=False)
    info = store.write_dataset(CELLS, spec, region, store.bin_records(records(pts), LEVEL, specs), parquet=False)
    return len(pts), info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        n, info = run(r)
        print(f"{r}: {n} stops listed, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
