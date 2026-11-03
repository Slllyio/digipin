"""Night shelters for the urban homeless per block (Chennai; Greater Chennai Corporation map on OpenCity, public domain).

Dataset ``night_shelters`` (L7):

    shelters    shelters under the Shelter for Urban Homeless scheme (NULM) in the block
    for_men     shelters for men
    for_women   shelters for women
    for_children shelters for boys or girls
    special     special shelters: psycho-social needs, disability, elderly, transgender and other special shelters

Only the coordinates and the shelter type are read: the map also carries caretakers' and officers' names and phone
numbers, which are never parsed or kept.

    python -m pipeline.realestate.nightshelters
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "chennai-shelters"
RESOURCE = "Chennai Night Shelters Map"
TYPE = re.compile(r'<SimpleData name="TYPE_SHELT">([^<]*)<')
COORDS = re.compile(r"<coordinates>\s*([-\d.]+),([-\d.]+)")


def kind(text):
    """Field for a TYPE_SHELT value."""
    t = text.lower()
    if "special" in t or "psycho" in t or "disab" in t or "challenged" in t or "elderly" in t or "transgender" in t:
        return "special"
    if "child" in t:
        return "for_children"
    if "women" in t and "men and women" not in t:
        return "for_women"
    if "men" in t:
        return "for_men"
    return None


def placemarks(text):
    """[(lng, lat, kind)] from the KML: type and coordinates only."""
    out = []
    for pm in text.split("<Placemark")[1:]:
        c = COORDS.search(pm)
        if not c:
            continue
        t = TYPE.search(pm)
        out.append((float(c.group(1)), float(c.group(2)), kind(t.group(1)) if t else None))
    return out


def records(points, bbox):
    w, s, e, n = bbox
    for lng, lat, k in points:
        if w <= lng <= e and s <= lat <= n:
            r = {"lat": lat, "lng": lng, "shelters": 1}
            if k:
                r[k] = 1
            yield r


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec("shelters", "Night shelters for the urban homeless", agg="sum", unit="shelters", ramp="greens", higher_is="better"),
             FieldSpec("for_men", "Shelters for men", agg="sum", unit="shelters", ramp="greens", higher_is="better"),
             FieldSpec("for_women", "Shelters for women", agg="sum", unit="shelters", ramp="greens", higher_is="better"),
             FieldSpec("for_children", "Shelters for children", agg="sum", unit="shelters", ramp="greens", higher_is="better"),
             FieldSpec("special", "Special shelters (psycho-social needs, disability, elderly, transgender)", agg="sum", unit="shelters", ramp="greens", higher_is="better")]
    spec = DatasetSpec(
        id="night_shelters", title="Night shelters for the homeless (Chennai)", level=LEVEL, fields=specs, group="Real estate",
        description="Greater Chennai Corporation's night shelter map on data.opencity.in (Shelter for Urban Homeless scheme): "
                    "shelters by who they take in. Only locations and shelter types are used.",
        source="pipeline/realestate/nightshelters.py (OpenCity Chennai night shelters map)",
        license="Public domain (Greater Chennai Corporation via data.opencity.in)", default_field="shelters", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.newroads import resource_url
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    pts = placemarks(requests.get(resource_url(PACKAGE, RESOURCE), timeout=300).content.decode("utf-8-sig"))
    recs = list(records(pts, bbox_for("chennai")))
    info = cell_dataset("chennai", recs)
    kinds = {k: sum(1 for r in recs if k in r) for k in ("for_men", "for_women", "for_children", "special")}
    print(f"chennai: {len(recs)} shelters {kinds}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
