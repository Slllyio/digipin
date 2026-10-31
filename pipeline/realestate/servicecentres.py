"""Citizen service centres per block (Bengaluru and Chennai; OpenCity maps, public domain).

Dataset ``service_centres`` (L7):

    csc         Common Service Centres (Aadhaar updates, certificates, bill payments, scheme applications)
    grama_one   Grama One citizen service centres (Karnataka government services, peri-urban panchayats)
    aadhaar     Aadhaar enrolment and update centres (Chennai: Greater Chennai Corporation map)

Only coordinates are read: the maps also carry operator names and phone numbers, which are never parsed or kept.

    python -m pipeline.realestate.servicecentres [--region bengaluru,chennai]
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "grama-one-centres-in-karnataka-and-bengaluru"
SOURCES = [("csc", "Customer Service Centre Locations in Bengaluru Urban"), ("grama_one", "Grama One Locations in Bengaluru Urban")]
REGION_SOURCES = {     # region: (OpenCity dataset, [(field, resource name prefix)], who)
    "bengaluru": (PACKAGE, SOURCES, "Common Service Centre and Grama One locations in Bengaluru Urban district from the Karnataka e-governance maps"),
    "chennai": ("chennai-aadhaar-enrollment-centres", [("aadhaar", "Map of Aadhaar Enrollment Centres")], "Aadhaar enrolment centres from the Chennai map"),
}
COORDS = re.compile(r"<coordinates>\s*([-\d.]+),([-\d.]+)")


def coords(text):
    """[(lng, lat)] of every placemark, read from <coordinates> only."""
    return [(float(x), float(y)) for x, y in COORDS.findall(text)]


def records(kind_points, bbox):
    w, s, e, n = bbox
    seen = set()
    for kind, pts in kind_points:
        for lng, lat in pts:
            k = (kind, round(lng, 5), round(lat, 5))
            if w <= lng <= e and s <= lat <= n and k not in seen:
                seen.add(k)
                yield {"lat": lat, "lng": lng, kind: 1}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("csc", "Common Service Centres", agg="sum", unit="centres", ramp="greens", higher_is="better"),
             FieldSpec("grama_one", "Grama One centres", agg="sum", unit="centres", ramp="greens", higher_is="better"),
             FieldSpec("aadhaar", "Aadhaar enrolment centres", agg="sum", unit="centres", ramp="greens", higher_is="better")]
    spec = DatasetSpec(
        id="service_centres", title="Citizen service centres (CSC, Grama One, Aadhaar)", level=LEVEL, fields=specs, group="Real estate",
        description=f"{REGION_SOURCES[region][2]} on data.opencity.in: where residents get Aadhaar updates, certificates, "
                    "bill payments and scheme applications done.",
        source="pipeline/realestate/servicecentres.py (OpenCity CSC and Grama One maps)",
        license="Public domain (Karnataka e-governance via data.opencity.in)", default_field="aadhaar" if region == "chennai" else "csc", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.newroads import resource_url
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    for region in ap.parse_args(argv).region.split(","):
        pkg, sources, _ = REGION_SOURCES[region]
        kp = [(kind, coords(requests.get(resource_url(pkg, name), timeout=300).content.decode("utf-8-sig"))) for kind, name in sources]
        recs = list(records(kp, bbox_for(region)))
        info = cell_dataset(region, recs)
        print(f"{region}: {({k: sum(1 for r in recs if k in r) for k, _ in sources})}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
