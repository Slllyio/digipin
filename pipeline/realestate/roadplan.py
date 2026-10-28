"""Planned road widths from Bengaluru's Revised Master Plan 2015 road network (OpenCity, public domain).

Per L7 block (dataset ``road_plan``):

    plan_km       length of RMP 2015 roads with a planned width (widening or new link)
    wide_km       of it, roads planned 24 m wide or more
    link_km       new link roads the plan proposes (not yet built when the plan was made)
    max_width_m   widest planned road in the block

Map: BDA's RMP 2015 road width map (23,238 segments; RR_WIDTH_P is the planned right of way, RR_TP_TYPE W widening or
C connection). Lines are walked in pieces of at most 25 m, each piece going to the block at its midpoint.

    python -m pipeline.realestate.roadplan
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from pipeline.realestate.sewers import pieces

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
WIDE_M = 24
URL = ("https://data.opencity.in/dataset/0a72695d-0c48-4442-b8ee-e2a24b157d66/resource/bd9d5ea1-40c8-4699-87c9-d4a4f303cfff/"
       "download/ed239bef-1bf5-4926-8621-2fd84c7db3d0.kml")
PLACEMARK = re.compile(r"<Placemark>(.*?)</Placemark>", re.S)
WIDTH = re.compile(r'name="RR_WIDTH_P">([\d.]+)<')
TYPE = re.compile(r'name="RR_TP_TYPE">([^<]*)<')
LINE = re.compile(r"<LineString>\s*<coordinates>([^<]+)</coordinates>")


def roads(text):
    """Yield (coords, planned width m, is_new_link) per road line."""
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        w = WIDTH.search(body)
        if not w:
            continue
        t = TYPE.search(body)
        for ls in LINE.finditer(body):
            pts = [tuple(map(float, p.split(",")[:2])) for p in ls.group(1).split()]
            if len(pts) >= 2:
                yield pts, float(w.group(1)), bool(t and t.group(1).strip().upper() == "C")


def accumulate(items, acc):
    from pipeline.cells.store import cell_code
    for pts, width, link in items:
        for lat, lng, m in pieces(pts):
            code = cell_code(LEVEL, lat, lng, None)
            if code is None:
                continue
            r = acc.setdefault(code, [0.0, 0.0, 0.0, 0.0])
            r[0] += m
            if width >= WIDE_M:
                r[1] += m
            if link:
                r[2] += m
            r[3] = max(r[3], width)
    return acc


def cell_dataset(region, acc):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("plan_km", "RMP 2015 roads with a planned width", agg="sum", unit="km", ramp="viridis", higher_is="better"),
        FieldSpec("wide_km", f"Roads planned {WIDE_M} m wide or more", agg="sum", unit="km", ramp="viridis", higher_is="better"),
        FieldSpec("link_km", "New link roads proposed", agg="sum", unit="km", ramp="viridis", higher_is="better"),
        FieldSpec("max_width_m", "Widest planned road", agg="max", unit="m", ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="road_plan", title="Planned road widths (Bengaluru RMP 2015)", level=LEVEL, fields=specs, group="Real estate",
        description="BDA's Revised Master Plan 2015 road width map on data.opencity.in: length of roads with a planned right of way "
                    "per block, roads planned 24 m or wider, proposed new link roads and the widest planned road.",
        source="pipeline/realestate/roadplan.py (OpenCity Bengaluru road width map)",
        license="Public domain (BDA via data.opencity.in)", default_field="max_width_m", extrude=False)
    recs = [{"digipin": code, "plan_km": round(r[0] / 1000, 3), "wide_km": round(r[1] / 1000, 3), "link_km": round(r[2] / 1000, 3),
             "max_width_m": r[3]} for code, r in acc.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--kml", help="read the road width KML from this file instead of downloading")
    a = ap.parse_args(argv)
    if a.kml:
        text = Path(a.kml).read_text("utf-8-sig", errors="replace")
    else:
        import requests
        text = requests.get(URL, timeout=600).content.decode("utf-8-sig", errors="replace")
    acc = accumulate(roads(text), {})
    info = cell_dataset("bengaluru", acc)
    print(f"bengaluru: {sum(r[0] for r in acc.values()) / 1000:.0f} km of planned roads "
          f"({sum(r[1] for r in acc.values()) / 1000:.0f} km at {WIDE_M} m+, {sum(r[2] for r in acc.values()) / 1000:.0f} km new links) "
          f"in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
