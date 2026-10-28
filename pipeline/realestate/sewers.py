"""Sewer lines from the network maps for Bengaluru (BWSSB), Chennai (CMWSSB) and Pune (PMC) (OpenCity, public domain).

Per L7 block (dataset ``sewers``):

    sewer_m    length of sewer line in the block
    in_area    1 where the municipal corporation's ward map (``wards`` dataset) holds the block: the lens judges gaps only
               there, as cantonments, other towns and villages past the limit run their own drainage
    trunk_m    of it, trunk sewers: 300 mm across or more, or those PMC marks Trunk_Sewer in Pune (most of Pune's
               collection sewers are 300 mm themselves)

Maps: BWSSB sewerage line maps (KGIS) by diameter, under 150 mm, 150-300 mm and 300 mm and above; CMWSSB's sewer main
network (about 181,000 pipes, 4,200 km, pipe size as a code); PMC's drainage map, which OpenCity lists as storm-water
drains but which is mostly the sewer network (road, nala and river sewers, about 2,190 km; its storm drains and nalas
are left out here). Lines are walked in steps of about STEP_M and each step's
length goes to the block holding its midpoint.

    python -m pipeline.realestate.sewers --region bengaluru,chennai,pune
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
CHENNAI = ("https://data.opencity.in/dataset/c9844771-3129-4bc8-99d7-398dd93db1fa/resource/a819c121-0d4a-4f6e-943d-2bcc610f6954/"
           "download/673f4683-9987-4101-b25c-8df48b448378.kmz")
PUNE = ("https://data.opencity.in/dataset/a83b2053-2250-4e3c-9759-521c81679d24/resource/7b7bb529-d324-48c2-95eb-8eabbab4381b/"
        "download/4390b641-12ad-4438-bc6b-c938ea7ae5de.kmz")
PLACEMARK = re.compile(r"<Placemark\b[^>]*>(.*?)</Placemark>", re.S)
DIAM = re.compile(r'name="Diameter">([\d.]+)<')
SIZE_CODE = re.compile(r'name="size_of_pipe_mm">(\d+)<')
CATEGORY = re.compile(r'name="category">([^<]*)<')
ROLE = re.compile(r'name="drainaige_">(\w+)<')
LINE = re.compile(r"<LineString>.*?<coordinates>\s*([^<]+?)\s*</coordinates>", re.S)
# CMWSSB's size codes (the "Sewer Main Codes" note published with the map), code -> mm
CMWSSB_MM = {1: 100, 2: 150, 3: 200, 4: 250, 5: 300, 6: 350, 8: 400, 9: 450, 10: 500, 11: 600, 12: 700, 14: 750, 15: 800,
             16: 900, 17: 1000, 18: 1100, 19: 1200, 23: 1600, 29: 225, 30: 125, 31: 160, 32: 1050}


def lines(text):
    """Yield (coords [(lng, lat)], diameter_mm or None, trunk) for each sewer Placemark. trunk is True or False where the
    map names the sewer's role (PMC), else None and the diameter decides. PMC storm drains and nalas are skipped."""
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        cat, role = CATEGORY.search(body), ROLE.search(body)
        if cat and "sewer" not in cat.group(1).lower():
            continue
        trunk = role.group(1).lower().startswith("trunk") if role else None
        d, c = DIAM.search(body), SIZE_CODE.search(body)
        diam = float(d.group(1)) if d else (CMWSSB_MM.get(int(c.group(1))) if c else None)
        for ls in LINE.finditer(body):
            pts = [tuple(map(float, p.split(",")[:2])) for p in ls.group(1).split()]
            if len(pts) >= 2:
                yield pts, diam, trunk


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
    for pts, diam, trunk in items:
        for lat, lng, m in pieces(pts):
            code = cell_code(LEVEL, lat, lng, None)
            if code is None:
                continue
            r = acc.setdefault(code, [0.0, 0.0])
            r[0] += m
            if trunk if trunk is not None else (diam is not None and diam >= 300):
                r[1] += m
    return acc


def download(url, dst):
    import requests
    for attempt in range(4):
        try:
            with requests.get(url, stream=True, timeout=900) as r, open(dst, "wb") as f:
                r.raise_for_status()
                f.writelines(r.iter_content(1 << 20))
            return
        except (requests.RequestException, OSError):
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


def corporation_cells(region, root=CELLS):
    """L7 blocks the ``wards`` dataset places in a corporation ward, or None."""
    import json

    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next((d for d in (cat.get("datasets") or []) if d["id"] == "wards"), None)
    entry = ds and next((r for r in ds["regions"] if r["name"] == region), None)
    if not entry:
        return None
    t = store.read_region(root, entry)
    return [c for c, v in zip(t.codes, t.columns["ward"]) if v]


def cell_dataset(region, acc, area=None):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("sewer_m", "Sewer line length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("trunk_m", "Trunk sewer length (300 mm and above; PMC trunk sewers in Pune)", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("in_area", "Inside the municipal corporation's wards", agg="max", unit="", domain=[0, 1], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="sewers", title="Sewer network (BWSSB, CMWSSB and PMC maps)", level=LEVEL, fields=specs, group="Real estate",
        description="BWSSB's sewerage line maps for Bengaluru (KGIS, by pipe diameter), CMWSSB's sewer main network for "
                    "Chennai and PMC's drainage map (road, nala and river sewers) for Pune on data.opencity.in: sewer "
                    "length per block and trunk sewers (300 mm and wider; PMC trunk sewers in Pune).",
        source="pipeline/realestate/sewers.py (OpenCity BWSSB sewerage line maps, CMWSSB sewer main network, PMC drainage map)",
        license="Public domain (BWSSB, CMWSSB and PMC via data.opencity.in)", default_field="sewer_m", extrude=False)
    recs = [{"digipin": code, "sewer_m": round(r[0]), "trunk_m": round(r[1])}
            for code, r in acc.items()]
    recs += [{"digipin": code, "in_area": 1} for code in area or ()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def read_kml(path):
    """Text of a .kml, or of the first .kml inside a .kmz."""
    if str(path).endswith(".kmz"):
        import zipfile
        with zipfile.ZipFile(path) as z:
            return z.read(next(n for n in z.namelist() if n.endswith(".kml"))).decode("utf-8-sig", errors="replace")
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        return f.read()


SOURCES = {"bengaluru": [OPENCITY + p for p in MAPS], "chennai": [CHENNAI], "pune": [PUNE]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    for region in a.region.split(","):
        acc = {}
        with tempfile.TemporaryDirectory() as tmp:
            for url in SOURCES[region]:
                name = url.rsplit("/", 1)[-1]
                src = os.path.join(a.from_dir or tmp, name)
                if not os.path.exists(src):
                    download(url, src)
                accumulate(lines(read_kml(src)), acc)
                print(f"{region}: {name}: {sum(r[0] for r in acc.values()) / 1000:.0f} km so far")
        info = cell_dataset(region, acc, corporation_cells(region))
        print(f"{region}: {sum(r[0] for r in acc.values()) / 1000:.0f} km of sewer in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
