"""Fire stations from the fire services' own maps (OpenCity, public domain).

Per L7 block (dataset ``fire_stations_official``):

    stations   fire stations the city or state fire service lists in the block

Maps: Mumbai Fire Brigade (BMC, 2023 edits), Pune Fire Brigade (PMC), Telangana Fire Services in Hyderabad (GHMC 2018)
and Karnataka State Fire and Emergency Services (KGIS; the Bengaluru list plus the state list clipped to the region,
which adds the suburban stations). OpenStreetMap and Overture list only some of these; the lens loader tops up
``places.fire_stations`` with whichever source lists more per block.

    python -m pipeline.realestate.firestations --region mumbai,pune,hyderabad,bengaluru
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
    "mumbai": ["fcc98df6-0ec9-41cb-ac2c-62fc2239d1a5/resource/f63ffd99-167a-4051-92ff-aec139d453eb/download/02b7168c-a860-46f7-9fa2-98f4c2bc9320.kml"],
    "pune": ["49fd476d-ace4-4610-918c-cb09f4171cb2/resource/201f577f-a095-4313-b724-ae3ec3587fe7/download/d185bb0c-2307-4a7d-9106-11cd61570165.kml"],
    "hyderabad": ["4535e725-7d20-457e-86af-0c8b7b7ed9a0/resource/43858169-104f-49f5-964b-1896e3070f37/download/645db6ae-acbb-43dc-a503-5c7816579430.kml"],
    "bengaluru": ["2996ae84-22be-4976-abef-425320d16b2c/resource/2e2d7b43-4749-424e-bdcd-fd0af3896574/download/09faaa35-363d-45e5-818c-746c41a79d34.kml",
                  "2996ae84-22be-4976-abef-425320d16b2c/resource/bd357bb4-e4f9-4cba-b271-5c9477c669df/download/af2989c1-f0df-4c4d-b19a-ef37cda64949.kml"],
}


def stations(points, bbox=None):
    """Unique station points (lng, lat) inside India and the (west, south, east, north) bbox; the same station on two lists counts once (~100 m)."""
    seen, out = set(), []
    for lng, lat, _ in points:
        if not (60 < lng < 100 and 5 < lat < 40):
            continue
        if bbox and not (bbox[0] <= lng <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        k = (round(lng, 3), round(lat, 3))
        if k in seen:
            continue
        seen.add(k)
        out.append((lng, lat))
    return out


def fetch(region):
    import requests
    pts = []
    for path in SOURCES[region]:
        pts += kml_points(requests.get(OPENCITY + path, timeout=300).content.decode("utf-8-sig"))
    return pts


def cell_dataset(region, pts):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("stations", "Fire stations (fire service list)", agg="sum", unit="stations", ramp="reds", higher_is="better")]
    spec = DatasetSpec(
        id="fire_stations_official", title="Fire stations (fire service maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Fire stations from the fire services' own maps on data.opencity.in, counted per block: Mumbai Fire Brigade, "
                    "Pune Fire Brigade, Telangana Fire Services in Hyderabad (2018) and Karnataka State Fire and Emergency Services "
                    "for Bengaluru and its suburbs. Tops up the OpenStreetMap/Overture fire-station counts that the safety lenses read.",
        source="pipeline/realestate/firestations.py (OpenCity fire station maps)",
        license="Public domain (BMC, PMC, GHMC, KSFES via data.opencity.in)", default_field="stations", extrude=False)
    recs = ({"lat": lat, "lng": lng, "stations": 1} for lng, lat in pts)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        pts = stations(fetch(r), bbox_for(r))
        info = cell_dataset(r, pts)
        print(f"{r}: {len(pts)} fire stations in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
