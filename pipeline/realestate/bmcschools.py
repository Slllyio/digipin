"""Mumbai schools from BMC's education department maps (OpenCity, public domain).

Per L7 block (dataset ``schools_official``):

    schools     schools listed in the block (all three maps, the same site counted once)
    municipal   BMC municipal primary and secondary schools
    aided       private aided schools
    unaided     private unaided schools

The lens loader tops up ``emergency_access.schools`` (OpenStreetMap) with whichever source lists more per block, so
the school-run, relief-camp and school-safety lenses see BMC's list.

    python -m pipeline.realestate.bmcschools
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/12b66346-5f5e-4980-bdea-b41465f3c883/resource/"
MAPS = {
    "municipal": "c5a238c6-69d5-49ed-a1b1-812ca4037697/download/a1e7a777-bf13-4799-8cfe-09a46247aed9.kml",
    "aided": "f92e6632-c921-4645-9abc-d4cbbeedd74a/download/8c3cb0d6-b9c9-43f3-be85-8d167f83518c.kml",
    "unaided": "c0ad04ae-156a-4b7d-a943-609d16d07d91/download/04e77044-423a-404c-b432-19dee5b96a47.kml",
}


def records(by_kind):
    """One record per school site: several schools (shifts, mediums) in one building count as one site in `schools`."""
    seen = set()
    for kind, pts in by_kind.items():
        for lng, lat, _ in pts:
            if not (72.7 < lng < 73.1 and 18.85 < lat < 19.35):
                continue
            k = (round(lng, 4), round(lat, 4))
            rec = {"lat": lat, "lng": lng, kind: 1, "schools": 0 if k in seen else 1}
            seen.add(k)
            yield rec


def cell_dataset(by_kind):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("schools", "School sites (BMC maps)", agg="sum", unit="sites", ramp="blues", higher_is="better"),
        FieldSpec("municipal", "BMC municipal schools", agg="sum", unit="schools", ramp="blues", higher_is="better"),
        FieldSpec("aided", "Private aided schools", agg="sum", unit="schools", ramp="blues", higher_is="better"),
        FieldSpec("unaided", "Private unaided schools", agg="sum", unit="schools", ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="schools_official", title="Schools (BMC education maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Mumbai schools from BMC's education department maps on data.opencity.in: municipal primary and secondary, "
                    "private aided and private unaided, counted per block (a building housing several schools is one site).",
        source="pipeline/realestate/bmcschools.py (OpenCity Mumbai school maps)",
        license="Public domain (BMC via data.opencity.in)", default_field="schools", extrude=False)
    return store.write_dataset(CELLS, spec, "mumbai", store.bin_records(records(by_kind), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    by_kind = {k: kml_points(requests.get(OPENCITY + p, timeout=300).content.decode("utf-8-sig")) for k, p in MAPS.items()}
    info = cell_dataset(by_kind)
    print("mumbai: " + ", ".join(f"{len(v)} {k}" for k, v in by_kind.items()) + f" schools in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
