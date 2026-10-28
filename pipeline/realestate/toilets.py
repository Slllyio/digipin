"""Official public and community toilets from the corporations' own maps (OpenCity, public domain).

Per L7 block (dataset ``toilets_official``):

    toilets       public or community toilet blocks the corporation lists in the block
    seats         toilet seats in them, where the list gives seats (Mumbai)
    seats_women   seats for women (Mumbai)

Maps: PMC Pune (547), GCC Chennai (613), BMC Mumbai community and public toilets with seat counts (about 8,400) and
GHMC Hyderabad (574, September 2018). OpenStreetMap maps only a fraction of these; the toilets lens counts whichever
source lists more.

    python -m pipeline.realestate.toilets --region pune,chennai,mumbai,hyderabad
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
SOURCES = {
    "pune": ("fe85ec2b-e02a-4281-8d14-4af20b911f24/resource/98a32ad9-b757-48f1-96c7-0dfd8e9e1551/download/f1d88eea-0aab-4d8c-8c23-2acc84c1bd6a.kml", "PMC"),
    "chennai": ("f636a229-a7b3-4811-9060-d3e3d03f9cb4/resource/7d189798-80c4-4e79-9551-9d093e46c107/download/gcc_toilets.geojson", "GCC"),
    "mumbai": ("8bdae802-bb45-446e-98d7-aa7bff0b6acb/resource/8c4bcb72-21de-44a7-a776-ffefceb450f1/download/057c0e2f-9528-426e-9c8c-5fc1720c139b.kml", "BMC"),
    "hyderabad": ("1c007af6-7da8-4b0a-8df5-268ea53a5967/resource/1df6f070-68a2-4267-971b-2a4759343e65/download/ab52f5b6-6014-475b-9455-5edce09a042b.kml", "GHMC 2018"),
}


def _n(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v >= 0 else None


def kml_points(text):
    """[(lng, lat, props)] from a KML of point placemarks with SimpleData attributes."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)
    tag = lambda e: e.tag.rsplit("}", 1)[-1]
    out = []
    for pm in (e for e in root.iter() if tag(e) == "Placemark"):
        props = {d.get("name"): (d.text or "").strip() for d in pm.iter() if tag(d) == "SimpleData"}
        c = next((e for e in pm.iter() if tag(e) == "coordinates"), None)
        xy = (c.text or "").split()[0].split(",") if c is not None and (c.text or "").strip() else []
        if len(xy) >= 2:
            out.append((float(xy[0]), float(xy[1]), props))
    return out


def records(points):
    for lng, lat, p in points:
        if not (60 < lng < 100 and 5 < lat < 40):
            continue
        f, m = _n(p.get("Count_of_F")), _n(p.get("Count_of_M"))
        rec = {"lat": lat, "lng": lng, "toilets": 1}
        if f is not None or m is not None:
            rec["seats"] = (f or 0) + (m or 0)
            rec["seats_women"] = f or 0
        yield rec


def fetch(region):
    import requests
    path, _ = SOURCES[region]
    text = requests.get(OPENCITY + path, timeout=300).content.decode("utf-8-sig")
    if path.endswith(".kml"):
        return kml_points(text)
    return [(*f["geometry"]["coordinates"][:2], f.get("properties") or {}) for f in json.loads(text)["features"]
            if (f.get("geometry") or {}).get("type") == "Point"]


def cell_dataset(region, points):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("toilets", "Public and community toilets (corporation list)", agg="sum", unit="toilets", ramp="greens", higher_is="better"),
        FieldSpec("seats", "Toilet seats (Mumbai)", agg="sum", unit="seats", ramp="greens", higher_is="better"),
        FieldSpec("seats_women", "Toilet seats for women (Mumbai)", agg="sum", unit="seats", ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="toilets_official", title="Public toilets (corporation maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Public and community toilet blocks from the corporations' own maps on data.opencity.in, counted per block: "
                    "PMC Pune, GCC Chennai, BMC Mumbai (with men's and women's seats) and GHMC Hyderabad (2018). Far more complete "
                    "than OpenStreetMap for these cities.",
        source="pipeline/realestate/toilets.py (OpenCity toilet maps)",
        license="Public domain (PMC, BMC, GHMC via data.opencity.in); open (GCC via data.opencity.in)", default_field="toilets", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(records(points), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        pts = fetch(r)
        info = cell_dataset(r, pts)
        print(f"{r}: {len(pts)} toilets listed in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
