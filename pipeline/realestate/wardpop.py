"""Residents rescaled to census ward counts (Bengaluru; GBA ward map via OpenCity, public domain).

GHSL GHS-POP R2023A (and Meta's HRSL, built on the same census units) puts far too few people in south and east
Bengaluru: a 1 km circle round Jayanagar holds about 5,500 residents against 1.97 lakh round Malleshwaram, and the
South and East corporations come to 12-18% of their Census 2011 count while West and North come to twice theirs.
GHSL's built volume shows no such gap, so the input census units, not the buildings, are off.

The GBA's 369-ward map of December 2025 carries each ward's Census 2011 population (TOT_P). For blocks inside a
GBA ward, ``calibrate`` keeps GHSL's total for those blocks but shares it out again:

    ward share   ∝ TOT_P × (residential built volume 2020 ÷ 2010 in the ward)
    block share  ∝ residential built volume 2020 (GHSL GHS-BUILT-V total minus non-residential) within the ward

``population`` and ``density_km2`` are rewritten, ``projected_2030`` keeps GHSL's 2030/2020 ratio for those blocks,
and ``change_2000_2020_pct`` is dropped there (GHSL's 2000 count has the same fault). Blocks outside the GBA keep
GHSL's figures. Only Corporation, ward_id and TOT_P are read from the map; the caste and tribe columns never are.

    python -m pipeline.realestate.wardpop [--region bengaluru]
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
CITIES = ("bengaluru",)


def gba_targets(text):
    """{(body, ward_no): Census 2011 population} from the GBA ward KML."""
    out = {}
    for pm in re.findall(r"<Placemark.*?</Placemark>", text, re.S):
        get = lambda f: (re.search(rf'name="{f}">([^<]*)<', pm) or [None, None])[1]
        corp, no, tot = get("Corporation"), get("ward_id"), get("TOT_P")
        try:
            out[(f"Bengaluru {corp.strip()} City Corporation", no.strip())] = float(tot)
        except (AttributeError, TypeError, ValueError):
            continue
    return out


def calibrate(rows, ward_of, targets, vol20, vol10, area):
    """Rewrite ``rows`` ({code: population fields}) in place for blocks whose ward has a census target.

    ward_of {code: ward key}; targets {ward key: 2011 population}; vol20/vol10 {code: residential built volume};
    area(code) → km². Returns the number of blocks rewritten.
    """
    inside = [c for c in rows if ward_of.get(c) in targets]
    if not inside:
        return 0
    total = sum(rows[c].get("population") or 0 for c in inside)
    grow30 = sum(rows[c].get("projected_2030") or 0 for c in inside) / total if total else 1
    by_ward = {}
    for c in inside:
        by_ward.setdefault(ward_of[c], []).append(c)
    weight = {}
    for w, cs in by_ward.items():
        v20, v10 = sum(vol20.get(c) or 0 for c in cs), sum(vol10.get(c) or 0 for c in cs)
        weight[w] = targets[w] * (min(v20 / v10, 3) if v10 else 1)
    norm = total / sum(weight.values())
    for w, cs in by_ward.items():
        ward_pop = weight[w] * norm
        vs = [max(vol20.get(c) or 0, 0) for c in cs]
        sv = sum(vs)
        for c, v in zip(cs, vs):
            p = ward_pop * (v / sv if sv else 1 / len(cs))
            r = rows[c]
            r["population"] = round(p)
            r["density_km2"] = round(p / area(c))
            r["projected_2030"] = round(p * grow30)
            r.pop("change_2000_2020_pct", None)
    return len(inside)


def _wards(region, root=CELLS):
    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "wards")
    t = store.read_region(root, next(r for r in ds["regions"] if r["name"] == region))
    return {c: (b, str(n)) for c, b, n in zip(t.codes, t.columns["body"], t.columns["ward_no"]) if b and n is not None}


def _volumes(region):
    """({code: residential built volume 2020}, {code: 2010}) from GHSL GHS-BUILT-V R2023A."""
    from pipeline.cells import earthengine as gee
    from pipeline.cells.ee_layers import _bbox
    ee = gee.init()
    _, bbox = _bbox(region)
    res = lambda y: (ee.Image(f"JRC/GHSL/P2023A/GHS_BUILT_V/{y}").select("built_volume_total")
                     .subtract(ee.Image(f"JRC/GHSL/P2023A/GHS_BUILT_V/{y}").select("built_volume_nres")).rename(f"v{y}"))
    raw = gee.fetch(gee.to_cells(ee.Image.cat([res(2020), res(2010)]), 100), bbox, LEVEL)
    return {c: v.get("v2020") for c, v in raw.items()}, {c: v.get("v2010") for c, v in raw.items()}


def targets(region):
    import requests

    from pipeline.realestate.wards import OPENCITY, SOURCES
    _, kind, path, *_ = SOURCES[region][0]
    r = requests.get(OPENCITY + path, timeout=180)
    r.raise_for_status()
    return gba_targets(r.content.decode("utf-8-sig"))


def calibrate_region(region, rows):
    """Rescale a freshly baked population ``rows`` dict for ``region`` (no-op outside CITIES)."""
    if region not in CITIES:
        return 0
    from pipeline.cells import earthengine as gee
    v20, v10 = _volumes(region)
    return calibrate(rows, _wards(region), targets(region), v20, v10, gee.cell_area_km2)


def main(argv=None):
    from pipeline.cells import store
    from pipeline.cells.ee_layers import population
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    region = ap.parse_args(argv).region
    spec, table = population(region)          # population() calls calibrate_region itself
    info = store.write_dataset(CELLS, spec, region, table, parquet=False)
    print(f"{region}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
