"""Colleges per block from Karnataka's 2023 higher-education maps for Bengaluru Urban (KGIS via OpenCity, public domain).

Per L7 block (dataset ``colleges``):

    pu            pre-university (class 11-12) colleges
    degree        degree colleges (arts, science, commerce)
    govt_degree   of the degree colleges, government ones (a separate map; not added again to ``colleges``)
    engineering   engineering colleges
    polytechnic   polytechnics (diploma)
    university    universities
    colleges      all of the above (pu + degree + engineering + polytechnic + university)

Maps: the Bengaluru Urban layers of the Karnataka PU, degree, government degree, engineering, polytechnic and university
maps (2023, KGIS).

    python -m pipeline.realestate.colleges
"""
from __future__ import annotations

import argparse
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
R = "https://data.opencity.in/dataset/5141eee5-b4ee-4b8e-a72c-24c653f62738/resource/"
SOURCES = {     # field: path of its Bengaluru Urban map
    "pu": "ad60a729-f25f-4a16-9e2a-4583c9fecea1/download/82ebbe19-d5bb-42dc-aeaa-5bc923b11a53.kml",
    "degree": "644842b7-15d5-47aa-99b6-4dbdf9b6f705/download/1a88a76b-9fac-4b89-9a1b-4c029d17f645.kml",
    "govt_degree": "d55658d0-0fbb-4ddb-98fa-93afa1a59d70/download/0e81a342-02da-4e16-a686-6c4e05ed1081.kml",
    "engineering": "8b33da11-3d77-4e59-9dd1-f483246ab684/download/8811c15b-de98-415e-b83c-7c4a8233a677.kml",
    "polytechnic": "87566234-688d-43b4-acb4-600c5ee3fc16/download/56ceef01-64c1-4748-ae4a-71f0015048b6.kml",
    "university": "32287c10-3a42-4871-8822-d54257dc0a26/download/ac5c6ca5-f678-494e-a2cc-d8f595d8869e.kml",
}
LABELS = {"pu": "Pre-university colleges", "degree": "Degree colleges", "govt_degree": "Government degree colleges",
          "engineering": "Engineering colleges", "polytechnic": "Polytechnics", "university": "Universities"}


def records(kind, points):
    for lng, lat, _ in points:
        if 11 < lat < 14.5 and 76 < lng < 79:
            r = {"lat": lat, "lng": lng, kind: 1}
            if kind != "govt_degree":
                r["colleges"] = 1
            yield r


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec(k, v, agg="sum", unit="colleges", ramp="blues", higher_is="better") for k, v in LABELS.items()]
    specs.append(FieldSpec("colleges", "Colleges and universities", agg="sum", unit="colleges", ramp="blues", higher_is="better"))
    spec = DatasetSpec(
        id="colleges", title="Colleges and universities (Karnataka 2023 maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Pre-university, degree, engineering and polytechnic colleges and universities per block from the "
                    "Karnataka higher-education maps for Bengaluru Urban (2023, KGIS) on data.opencity.in.",
        source="pipeline/realestate/colleges.py (OpenCity Karnataka college maps)",
        license="Public domain (Government of Karnataka via data.opencity.in)", default_field="colleges", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import os

    import requests

    from pipeline.realestate.toilets import kml_points
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    recs, counts = [], {}
    for kind, path in SOURCES.items():
        local = os.path.join(a.from_dir, path.rsplit("/", 1)[-1]) if a.from_dir else None
        text = open(local, encoding="utf-8-sig").read() if local and os.path.exists(local) else requests.get(R + path, timeout=300).content.decode("utf-8-sig")
        got = list(records(kind, kml_points(text)))
        counts[kind] = len(got)
        recs += got
    info = cell_dataset("bengaluru", recs)
    print("bengaluru:", ", ".join(f"{v} {k}" for k, v in counts.items()), f"in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
