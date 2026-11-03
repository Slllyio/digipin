"""Old tank beds per block (Hyderabad; HYDRAA's tank survey via OpenCity, public domain).

HYDRAA mapped 920 tanks inside the Outer Ring Road on their old outlines (village maps from before the 1940s to the 1970s)
and classed each part as water or built up in 2023, with each tank's status in 2014 and 2023: live, partly or wholly
encroached, by buildings or by farming.

Per L7 block (dataset ``tank_beds``):

    tankbed_pct         share of the block inside an old tank outline (%)
    tankbed_built_pct   share of the block on a tank bed that is built up in 2023 (%)
    tankbed_water_pct   share of the block on a tank bed that still holds water in 2023 (%)
    tanks               tanks whose largest part lies in the block
    tanks_live          …of them live (not encroached) in 2023
    tanks_lost          …of them wholly encroached in 2023
    tanks_worse         …of them whose status worsened between 2014 and 2023

Only outlines and the status fields are read; survey numbers are not kept.

    python -m pipeline.realestate.tankbeds [--region hyderabad]
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PX_M = 10
PACKAGE, RESOURCE = "hyderabad-and-telangana-water-bodies", "Outer Ring Road Tanks"
RANK = {"Live": 0, "Partially Encroached - Built-up": 1, "Partially Encroached - Agriculture": 1,
        "Totally Encroached - Built-up": 2, "Totally Encroached - Agriculture": 2}
PLACEMARK = re.compile(r"<Placemark.*?</Placemark>", re.S)


def _field(pm, name):
    m = re.search(r'<SimpleData name="%s">(.*?)</SimpleData>' % re.escape(name), pm)
    return (m.group(1) if m else "").strip()


def parts(text):
    """[(tank id, built 2023?, status 2014, status 2023, [(outer, holes)])] for each mapped tank part."""
    from pipeline.realestate.ecolimits import kml_polygons
    out = []
    for pm in PLACEMARK.findall(text):
        polys = kml_polygons(f"<kml>{pm}</kml>")
        if polys:
            out.append((_field(pm, "ID"), _field(pm, "2023_class") == "Built Up", _field(pm, "WBS_2014"), _field(pm, "WBS_2023"), polys))
    return out


def tanks(ps):
    """[(lng, lat, live, lost, worse)] per tank, placed at the centre of its largest part."""
    from pipeline.realestate.parksofficial import ring_area_m2
    best = {}
    for tid, _, s14, s23, polys in ps:
        for outer, _ in polys:
            a = ring_area_m2(outer)
            if tid not in best or a > best[tid][0]:
                best[tid] = (a, outer, s14, s23)
    out = []
    for _, outer, s14, s23 in best.values():
        r14, r23 = RANK.get(s14), RANK.get(s23)
        out.append((sum(p[0] for p in outer) / len(outer), sum(p[1] for p in outer) / len(outer),
                    int(r23 == 0), int(r23 == 2), int(r14 is not None and r23 is not None and r23 > r14)))
    return out


def shares(bbox, ps, px_m=PX_M):
    import numpy as np

    from pipeline.realestate.ecolimits import Raster, block_shares, fill_polygons
    r = Raster(bbox, px_m)
    built = fill_polygons(r, [p for _, b, _, _, polys in ps if b for p in polys])
    water = fill_polygons(r, [p for _, b, _, _, polys in ps if not b for p in polys])
    print(f"tank beds: {(built | water).sum() * px_m ** 2 / 1e6:.1f} km², built up {(built & ~water).sum() * px_m ** 2 / 1e6:.1f} km²")
    return block_shares(r, {"tankbed_pct": built | water, "tankbed_built_pct": built & ~water, "tankbed_water_pct": water}, np.ones_like(built))


def records(sh, tk, bbox):
    w, s, e, n = bbox
    yield from ({"digipin": c, **v} for c, v in sh.items())
    for lng, lat, live, lost, worse in tk:
        if w <= lng <= e and s <= lat <= n:
            yield {"lat": lat, "lng": lng, "tanks": 1, "tanks_live": live, "tanks_lost": lost, "tanks_worse": worse}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("tankbed_pct", "Share of the block inside an old tank outline", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is=None),
        FieldSpec("tankbed_built_pct", "Share of the block on a tank bed built up by 2023", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("tankbed_water_pct", "Share of the block on a tank bed still holding water in 2023", agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="better"),
        FieldSpec("tanks", "Tanks surveyed (largest part in the block)", agg="sum", unit="tanks", ramp="blues", higher_is=None),
        FieldSpec("tanks_live", "Tanks still live in 2023", agg="sum", unit="tanks", ramp="greens", higher_is="better"),
        FieldSpec("tanks_lost", "Tanks wholly encroached by 2023", agg="sum", unit="tanks", ramp="reds", higher_is="worse"),
        FieldSpec("tanks_worse", "Tanks whose encroachment grew between 2014 and 2023", agg="sum", unit="tanks", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="tank_beds", title="Old tank beds (HYDRAA tank survey)", level=LEVEL, fields=specs, group="Environment",
        description="HYDRAA's survey of 920 tanks inside Hyderabad's Outer Ring Road on their old village-map outlines (before "
                    "the 1940s to the 1970s), each part classed as water or built up in 2023, with each tank's status in 2014 "
                    "and 2023 (live, partly or wholly encroached), via data.opencity.in.",
        source="pipeline/realestate/tankbeds.py (HYDRAA ORR tanks via OpenCity)",
        license="Public domain (HYDRAA via data.opencity.in)", default_field="tankbed_built_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.newroads import resource_url
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="hyderabad")
    region = ap.parse_args(argv).region
    ps = parts(requests.get(resource_url(PACKAGE, RESOURCE), timeout=600).content.decode("utf-8-sig"))
    tk, bbox = tanks(ps), bbox_for(region)
    print(f"{region}: {len(ps)} parts, {len(tk)} tanks, {sum(t[2] for t in tk)} live, {sum(t[3] for t in tk)} lost, {sum(t[4] for t in tk)} worse since 2014")
    info = cell_dataset(region, list(records(shares(bbox, ps), tk, bbox)))
    print(f"{region}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
