"""Free public primary care and maternity homes per block from the corporations' maps (OpenCity, public domain).

Dataset ``public_care`` (L7):

    primary    urban primary health centres, Namma Clinics, municipal dispensaries and health centres in the block
    maternity  public maternity homes in the block

Maps: Greater Chennai UPHCs and maternity units; Hyderabad district health centres; BBMP UPHCs and Namma Clinics
(2026) for Bengaluru. Mumbai City's maps round locations to 0.01 degrees (about 1 km), too coarse for walking reach,
so they are not used. The maps cover only the corporation or district, so lenses judge gaps only near listed centres.

    python -m pipeline.realestate.publiccare --region chennai,hyderabad,bengaluru
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
B = "https://data.opencity.in/dataset/"
SOURCES = {     # region: [(kind, path, name)]
    "chennai": [("primary", "e08b7485-40ab-4401-861f-f790ed8e5328/resource/5a81427f-0aa1-4270-8df4-5d4cef250912/download/a33b403b-f341-4214-8613-88e2ec227359.kml", "GCC UPHCs"),
                ("maternity", "e08b7485-40ab-4401-861f-f790ed8e5328/resource/4e57c154-eaf1-4738-ae6f-aa96df0c9d0d/download/6fd870e9-33e0-4f1d-843c-49692ea81eaf.kml", "GCC maternity units")],
    "hyderabad": [("primary", "b5ba02a1-450b-456d-a7ea-bf1cf29c0198/resource/4872026f-6c15-4097-a90a-e77588b5c781/download/2d9812bb-6901-4eca-90f9-a91ca50772a0.kml", "Hyderabad district health centres")],
    "bengaluru": [("primary", "b7a0a3ea-36b4-4706-9f63-b139097e089e/resource/6a3d171d-dd83-490d-95c3-81f748b2d292/download/698cc8fd-ff4f-48cb-88ac-4bf0478c6338.kml", "BBMP UPHCs"),
                  ("primary", "b7a0a3ea-36b4-4706-9f63-b139097e089e/resource/9005167b-69f2-4448-abd9-03df4c7613f1/download/namma_clinics_final.geojson", "Namma Clinics 2026")],
}


def points(path, text):
    from pipeline.realestate.toilets import kml_points
    if path.endswith(".kml"):
        return kml_points(text)
    return [(*f["geometry"]["coordinates"][:2], f.get("properties") or {}) for f in json.loads(text)["features"]
            if (f.get("geometry") or {}).get("type") == "Point"]


def records(kind_points):
    seen = set()
    for kind, pts in kind_points:
        for lng, lat, _ in pts:
            if not (60 < lng < 100 and 5 < lat < 40):
                continue
            k = (kind, round(lng, 4), round(lat, 4))        # the same centre on two lists (UPHC and clinic) counts once
            if k in seen:
                continue
            seen.add(k)
            yield {"lat": lat, "lng": lng, kind: 1}


def run(region):
    import requests

    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    kp = [(kind, points(path, requests.get(B + path, timeout=300).content.decode("utf-8-sig"))) for kind, path, _ in SOURCES[region]]
    specs = [FieldSpec("primary", "Public primary care centres (UPHC, clinic, dispensary)", agg="sum", unit="centres", ramp="greens", higher_is="better"),
             FieldSpec("maternity", "Public maternity homes", agg="sum", unit="homes", ramp="greens", higher_is="better")]
    names = "; ".join(f"{r}: " + ", ".join(n for _, _, n in s) for r, s in SOURCES.items())
    spec = DatasetSpec(
        id="public_care", title="Public primary care and maternity homes (OpenCity)", level=LEVEL, fields=specs, group="Real estate",
        description="Free public primary care centres and maternity homes per block from the corporations' maps on "
                    f"data.opencity.in ({names}). Some maps cover only the corporation or district.",
        source="pipeline/realestate/publiccare.py (OpenCity health facility maps)", license="Public domain (data.opencity.in)",
        default_field="primary", extrude=False)
    info = store.write_dataset(CELLS, spec, region, store.bin_records(records(kp), LEVEL, specs), parquet=False)
    return {k: sum(len(p) for kk, p in kp if kk == k) for k in ("primary", "maternity")}, info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        n, info = run(r)
        print(f"{r}: {n} listed, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
