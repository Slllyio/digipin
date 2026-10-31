"""Cremation grounds, crematoriums and burial grounds from the corporations' maps (OpenCity, public domain).

Per L7 block (dataset ``funeral_sites``):

    sites      cremation grounds, crematoriums and burial grounds listed in the block
    electric   of them, electric or gas crematoriums (where the list says; Bengaluru, Chennai)

Lists do not separate burial from cremation reliably (GCC calls every site a burial ground, BMC calls Hindu cremation
grounds cemeteries), so only the total and the electric or gas crematoriums are kept.

Maps: BMC funeral and cremation sites (Mumbai, with the community each serves), PMC cremation and burial grounds
(Pune), GCC burial grounds and crematoriums (Chennai) and BBMP electric crematoriums plus burial grounds (Bengaluru;
BBMP's list has no open cremation grounds).

    python -m pipeline.realestate.funeral --region mumbai,pune,chennai,bengaluru
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
    "mumbai": [("36a72661-5725-42d9-8059-ceb84f2c9436/resource/c08b1545-af80-4ded-b1df-f600de3aa9bb/download/d8811870-5e39-4d24-8ac4-089b4a0724cf.kml", None)],
    "pune": [("e052723f-946f-4a84-a6c8-78cce5699c8c/resource/801abd42-ccdc-46cb-8e20-30aaf9f5582e/download/pmc_cremation_grounds.kml", None)],
    "chennai": [("41df3b44-af3c-4a09-8165-679b9f313518/resource/0c601b34-023f-408d-88d3-b554dcf0c1f1/download/513e5f7a-0f7d-4e98-ad9f-c993c45e5521.kml", None)],
    "bengaluru": [("846ff5ff-24be-4ce0-9814-7424e6f4533e/resource/04e6c545-f99f-4c42-bd14-612b4bc07b71/download/d7d2d279-3d4c-4b69-a389-5f3be42edbf6.kml", True),
                  ("846ff5ff-24be-4ce0-9814-7424e6f4533e/resource/3e13315d-04c8-46f1-9877-d870112634ba/download/3b6dccb3-4b81-4955-b0b6-f230e0b4af04.kml", None)],
}
ELECTRIC = ("electric", "gasifier", "gas crematorium", "vidyut")


def is_electric(props, hint):
    """True for an electric or gas crematorium: the list says so (`hint`) or its name or type does."""
    if hint:
        return True
    text = " ".join(str(props.get(k) or "") for k in ("ASSET_NAME", "REMARKS", "FUNERAL_SI", "structure_", "CrematoriumName")).lower()
    return any(w in text for w in ELECTRIC)


def records(points):
    seen = set()
    for lng, lat, props, hint in points:
        if not (60 < lng < 100 and 5 < lat < 40):
            continue
        k = (round(lng, 4), round(lat, 4))
        if k in seen:
            continue
        seen.add(k)
        yield {"lat": lat, "lng": lng, "sites": 1, "electric": 1 if is_electric(props, hint) else 0}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("sites", "Cremation and burial grounds", agg="sum", unit="sites", ramp="viridis", higher_is="better"),
        FieldSpec("electric", "Electric or gas crematoriums", agg="sum", unit="sites", ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="funeral_sites", title="Cremation and burial grounds (corporation maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Cremation grounds, crematoriums and burial grounds from the corporations' maps on data.opencity.in, counted per "
                    "block: BMC (Mumbai), PMC (Pune), GCC (Chennai) and BBMP electric crematoriums and burial grounds (Bengaluru).",
        source="pipeline/realestate/funeral.py (OpenCity cremation and burial ground maps)",
        license="Public domain (BMC, PMC, GCC, BBMP via data.opencity.in)", default_field="sites", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        pts = []
        for path, hint in SOURCES[r]:
            pts += [(lng, lat, p, hint) for lng, lat, p in kml_points(requests.get(OPENCITY + path, timeout=300).content.decode("utf-8-sig"))]
        recs = list(records(pts))
        info = cell_dataset(r, recs)
        print(f"{r}: {len(recs)} sites ({sum(x['electric'] for x in recs)} electric or gas) in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
