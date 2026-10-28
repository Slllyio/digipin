"""Sewer lines from BWSSB's network maps for Bengaluru (OpenCity, public domain).

Per L7 block (dataset ``sewers``):

    sewer_m    length of sewer line in the block
    trunk_m    of it, trunk sewers 300 mm across or more

Maps: BWSSB sewerage line maps (KGIS) by diameter, under 150 mm, 150-300 mm and 300 mm and above. Lines are walked in
steps of about STEP_M and each step's length goes to the block holding its midpoint.

    python -m pipeline.realestate.sewers
"""
from __future__ import annotations

import argparse
import math
import os
import re
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
STEP_M = 25
OPENCITY = "https://data.opencity.in/dataset/10de5e2c-2ab9-4d80-b709-d0315d47ed9f/resource/"
MAPS = [
    "4dd093a5-e24c-4fde-97f5-206be754d98b/download/5521d121-2da1-49a6-8e74-6e5cfca372e9.kml",
    "8bc1acfb-e28d-44da-8cce-6248693d47b4/download/a57f5572-ab3d-4527-bc14-88462156fa6b.kml",
    "3f02ce59-0e6d-456e-8fda-a2a8f946a5a4/download/0f28c5fb-8043-45b2-ba46-ce9e8f18e2fa.kml",
]
PLACEMARK = re.compile(r"<Placemark>(.*?)</Placemark>", re.S)
DIAM = re.compile(r'name="Diameter">([\d.]+)<')
LINE = re.compile(r"<LineString>\s*<coordinates>([^<]+)</coordinates>")


def lines(text):
    """Yield (coords [(lng, lat)], diameter_mm or None) for each sewer Placemark."""
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        d = DIAM.search(body)
        diam = float(d.group(1)) if d else None
        for ls in LINE.finditer(body):
            pts = [tuple(map(float, p.split(",")[:2])) for p in ls.group(1).split()]
            if len(pts) >= 2:
                yield pts, diam


def _seg_m(a, b):
    k = 111320.0
    return math.hypot((b[0] - a[0]) * k * math.cos(math.radians((a[1] + b[1]) / 2)), (b[1] - a[1]) * k)


def pieces(pts, step=STEP_M):
    """(lat, lng, metres) pieces of a polyline, each at most `step` long, placed at its midpoint."""
    for a, b in zip(pts, pts[1:]):
        L = _seg_m(a, b)
        k = max(1, math.ceil(L / step))
        for j in range(k):
            t = (j + 0.5) / k
            yield a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t, L / k


def accumulate(items, acc):
    from pipeline.cells.store import cell_code
    for pts, diam in items:
        for lat, lng, m in pieces(pts):
            code = cell_code(LEVEL, lat, lng, None)
            if code is None:
                continue
            r = acc.setdefault(code, [0.0, 0.0])
            r[0] += m
            if diam is not None and diam >= 300:
                r[1] += m
    return acc


def download(path, dst):
    import requests
    for attempt in range(4):
        try:
            with requests.get(OPENCITY + path, stream=True, timeout=900) as r, open(dst, "wb") as f:
                r.raise_for_status()
                f.writelines(r.iter_content(1 << 20))
            return
        except (requests.RequestException, OSError):
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


def cell_dataset(region, acc):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("sewer_m", "Sewer line length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("trunk_m", "Trunk sewer length (300 mm and above)", agg="sum", unit="m", ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="sewers", title="Sewer network (BWSSB maps)", level=LEVEL, fields=specs, group="Real estate",
        description="BWSSB's sewerage line maps for Bengaluru (KGIS, by pipe diameter) on data.opencity.in: sewer length per block and "
                    "trunk sewers 300 mm and wider.",
        source="pipeline/realestate/sewers.py (OpenCity BWSSB sewerage line maps)",
        license="Public domain (BWSSB via data.opencity.in)", default_field="sewer_m", extrude=False)
    recs = [{"digipin": code, "sewer_m": round(r[0]), "trunk_m": round(r[1])}
            for code, r in acc.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from-dir", help="read the KMLs (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    acc = {}
    with tempfile.TemporaryDirectory() as tmp:
        for path in MAPS:
            name = path.rsplit("/", 1)[-1]
            src = os.path.join(a.from_dir or tmp, name)
            if not os.path.exists(src):
                download(path, src)
            with open(src, encoding="utf-8-sig", errors="replace") as f:
                accumulate(lines(f.read()), acc)
            print(f"{name}: {sum(r[0] for r in acc.values()) / 1000:.0f} km so far")
    info = cell_dataset("bengaluru", acc)
    print(f"bengaluru: {sum(r[0] for r in acc.values()) / 1000:.0f} km of sewer in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
