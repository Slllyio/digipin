"""Street light poles from BBMP's 2024 zone maps (OpenCity, public domain).

Per L7 block (dataset ``street_lights``):

    poles     street light poles BBMP lists in the block
    led_pct   share of them fitted with LED lamps (the rest sodium-vapour, tube or unrecorded)

Maps: BBMP street light surveys for four of its eight 2024 zones (Bangalore East, RR Nagar, Bommanahalli,
Dasarahalli; about 1.9 lakh distinct poles with lamp type). The other zones are not published as maps,
so the lens judges only surveyed ground.

    python -m pipeline.realestate.streetlights
"""
from __future__ import annotations

import argparse
import re
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/722a447c-83f5-4630-9338-bddb0cd212bb/resource/"
ZONES = {
    "RR Nagar": "5bff7871-cc06-459f-ac71-a9e606613603/download/a27a410d-2c59-4992-8078-cf41d26df070.kml",
    "Bangalore East": "c9be7ed6-e96f-4f0b-a96d-9b1320a4127d/download/02b25d35-bf2c-4eee-ba24-9e00de15dc88.kml",
    "Bommanahalli": "14da06d7-327f-4018-94c4-5f4d43b1124e/download/7432f741-2312-4dff-9600-90036ceecf06.kml",
    "Dasarahalli": "881ef6f8-626d-47f0-97ec-c0651fda8e44/download/246fc5e3-b239-4f3c-b8cc-a8c9890dc2d8.kml",
}
PLACEMARK = re.compile(r"<Placemark>(.*?)</Placemark>", re.S)
TYPE = re.compile(r'name="Type">([^<]*)<')
COORD = re.compile(r"<coordinates>\s*([-\d.]+),([-\d.]+)")


def poles(text):
    """[(lng, lat, is_led)] from one zone KML; the same pole listed twice (~1 m) counts once."""
    seen, out = set(), []
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        c = COORD.search(body)
        if not c:
            continue
        lng, lat = float(c.group(1)), float(c.group(2))
        if not (77 < lng < 78.2 and 12.5 < lat < 13.5):
            continue
        k = (round(lng, 5), round(lat, 5))
        if k in seen:
            continue
        seen.add(k)
        t = TYPE.search(body)
        out.append((lng, lat, bool(t and "LED" in t.group(1).upper())))
    return out


def records(pts):
    for lng, lat, led in pts:
        yield {"lat": lat, "lng": lng, "poles": 1, "led": 1 if led else 0}


def fetch(path):
    import requests
    for attempt in range(4):
        try:
            r = requests.get(OPENCITY + path, timeout=900)
            r.raise_for_status()
            return r.content.decode("utf-8-sig", errors="replace")
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


def cell_dataset(region, pts):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("poles", "Street light poles (BBMP survey)", agg="sum", unit="poles", ramp="viridis", higher_is="better"),
        FieldSpec("led", "LED street light poles", agg="sum", unit="poles", ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="street_lights", title="Street lights (BBMP pole survey)", level=LEVEL, fields=specs, group="Real estate",
        description="Street light poles from BBMP's 2024 street light maps on data.opencity.in for four of its eight zones (Bangalore "
                    "East, RR Nagar, Bommanahalli, Dasarahalli), counted per block with how many carry LED lamps.",
        source="pipeline/realestate/streetlights.py (OpenCity BBMP street light maps)",
        license="Public domain (BBMP via data.opencity.in)", default_field="poles", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(records(pts), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from-dir", help="read the zone KMLs (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    pts = []
    for zone, path in ZONES.items():
        text = (Path(a.from_dir) / path.rsplit("/", 1)[-1]).read_text("utf-8-sig", errors="replace") if a.from_dir else fetch(path)
        z = poles(text)
        print(f"{zone}: {len(z)} poles, {sum(p[2] for p in z)} LED")
        pts += z
    info = cell_dataset("bengaluru", pts)
    print(f"bengaluru: {len(pts)} poles in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
