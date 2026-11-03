"""Storm-water drains per block from the corporations' drain maps (Chennai, Pune; OpenCity, public domain).

Per L7 block (dataset ``storm_drains``):

    swd_m      storm-water drain length in the block (roadside and major drains)
    closed_m   of it, drains with a cover or slab (GCC, Chennai)
    nalla_m    natural nalas and streams the map carries (PMC, Pune)
    in_area    1 where the corporation's ward map (``wards`` dataset) holds the block

Maps: GCC storm-water drains 2023 (about 10,300 drains, 2,225 km); PMC's drainage map, whose storm drains (1,122 km)
and nalas (404 km) are kept here and whose sewers feed ``sewers``. BBMP's maps hold only Bengaluru's major drains
(``drain_buffers``), too few to judge streets by. Lines are cut into pieces of at most 25 m placed at their midpoints (``sewers.pieces``).

    python -m pipeline.realestate.stormdrains --region chennai,pune
"""
from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path

from pipeline.realestate.sewers import CATEGORY, LINE, PLACEMARK, corporation_cells, download, pieces, read_kml

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
CHENNAI = ("https://data.opencity.in/dataset/e71414ae-d144-4e69-866d-48762c337929/resource/107ac467-2381-4718-9632-645560bc8360/"
           "download/c4907fed-934b-4342-a3f4-74226853719d.kml")
PUNE = ("https://data.opencity.in/dataset/a83b2053-2250-4e3c-9759-521c81679d24/resource/7b7bb529-d324-48c2-95eb-8eabbab4381b/"
        "download/4390b641-12ad-4438-bc6b-c938ea7ae5de.kmz")
DETAIL = re.compile(r'name="DRAIN_DETL">\s*([^<]*?)\s*<')
COVER = re.compile(r'name="COVER">\s*([^<]*?)\s*<')


def drains(text, kind=None):
    """Yield (coords, kind, closed) per drain line. kind is 'swd' or 'nalla'; PMC's category decides it and sewers
    are skipped; otherwise the caller's kind holds. closed is True where GCC records a cover or a closed drain."""
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        cat = CATEGORY.search(body)
        k = kind
        if cat:
            c = cat.group(1).lower()
            if "sewer" in c:
                continue
            k = "nalla" if c.startswith("nalla") else "swd"
        d, cv = DETAIL.search(body), COVER.search(body)
        closed = bool((d and d.group(1).lower().startswith(("closed", "temporary closed", "hidden"))) or (cv and cv.group(1).lower() in ("yes", "closed")))
        for ls in LINE.finditer(body):
            pts = [tuple(map(float, p.split(",")[:2])) for p in ls.group(1).split()]
            if len(pts) >= 2:
                yield pts, k or "swd", closed


def records(items):
    for pts, kind, closed in items:
        for lat, lng, m in pieces(pts):
            r = {"lat": lat, "lng": lng, "nalla_m" if kind == "nalla" else "swd_m": m}
            if closed and kind != "nalla":
                r["closed_m"] = m
            yield r


def cell_dataset(region, recs, area=None):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("swd_m", "Storm-water drain length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("closed_m", "Covered storm-water drain length (GCC)", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("nalla_m", "Nala and major drain length", agg="sum", unit="m", ramp="blues", higher_is="better"),
        FieldSpec("in_area", "Inside the municipal corporation's wards", agg="max", unit="", domain=[0, 1], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="storm_drains", title="Storm-water drains (corporation maps)", level=LEVEL, fields=specs, group="Environment",
        description="Storm-water drain length per block from the corporations' maps on data.opencity.in: GCC's 2023 drain map "
                    "for Chennai (with covered drains) and the storm drains and nalas in PMC's drainage map for Pune.",
        source="pipeline/realestate/stormdrains.py (OpenCity GCC and PMC drain maps)",
        license="Public domain (GCC and PMC via data.opencity.in)", default_field="swd_m", extrude=False)
    recs = list(recs) + [{"digipin": c, "in_area": 1} for c in area or ()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


SOURCES = {
    "chennai": [(CHENNAI, None)],
    "pune": [(PUNE, None)],
}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    for region in a.region.split(","):
        recs = []
        with tempfile.TemporaryDirectory() as tmp:
            for url, kind in SOURCES[region]:
                src = os.path.join(a.from_dir or tmp, url.rsplit("/", 1)[-1])
                if not os.path.exists(src):
                    download(url, src)
                recs += list(records(drains(read_kml(src), kind)))
        km = lambda k: sum(r.get(k, 0) for r in recs) / 1000
        info = cell_dataset(region, recs, corporation_cells(region))
        print(f"{region}: {km('swd_m'):.0f} km of storm drain ({km('closed_m'):.0f} km covered), {km('nalla_m'):.0f} km of nala, "
              f"{info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
