"""Residents rescaled to ward electors (Bengaluru, 2026 rolls) or 2024 electors per assembly seat (five more cities).

GHSL GHS-POP R2023A (and Meta's HRSL, built on the same census units) puts far too few people in south and east
Bengaluru: a 1 km circle round Jayanagar holds about 5,500 residents against 1.97 lakh round Malleshwaram, and the
South and East corporations come to 12-18% of their Census 2011 count while West and North come to twice theirs.
GHSL's built volume shows no such gap, so the input census units, not the buildings, are off.

For blocks inside a GBA ward (the 369-ward map of December 2025, via OpenCity), ``calibrate`` keeps GHSL's total for
those blocks but shares it out again:

    ward share   ∝ electors on the GBA's January 2026 draft roll (ward-wise counts, State Election Commission via
                   OpenCity, public domain; transcribed from the scanned table into data/realestate/
                   gba_ward_electors_2026.csv, every ward's male + female + others checked against its total and every
                   corporation's column sums against the printed sub-totals)
    block share  ∝ residential built volume 2020 (GHSL GHS-BUILT-V total minus non-residential) within the ward

``population`` and ``density_km2`` are rewritten, ``projected_2030`` keeps GHSL's 2030/2020 ratio for those blocks,
and ``change_2000_2020_pct`` is dropped there (GHSL's 2000 count has the same fault). Blocks outside the GBA keep
GHSL's figures. Earlier bakes shared by each ward's Census 2011 count (TOT_P on the ward map) grown by residential
volume 2010-2020; the 2026 roll needs no growth guess. ``gba_targets`` still reads TOT_P, and only Corporation,
ward_id and TOT_P are read from the map; the caste and tribe columns never are.

The same fault shows up elsewhere when GHSL's residents per assembly seat are set against the seat's 2024 electors
(Election Commission segment table via OpenCity, public domain): Dum Dum and Rajarhat Gopalpur in Kolkata, Mulund and
Thane in Mumbai and Pune Cantonment have five to six times fewer electors per GHSL resident than the city's middle
seat, Musheerabad and Amberpet in Hyderabad three to four times more. For ``ELECTORS`` cities, seats lying at least
``MIN_INSIDE`` (95%) inside the region box share GHSL's total for their blocks by electors (no growth factor: the rolls are of
2024), each seat's change capped at ``CAP`` times either way so a misdrawn seat cannot pile people into a few blocks,
and blocks share their seat's figure by residential built volume as above. Electors stand in for residents because
adults are a similar share of people across a city's seats; seats outside the region, or not matched to the
Election Commission's table by number and name, keep GHSL's figures.

    python -m pipeline.realestate.wardpop [--region bengaluru,hyderabad,mumbai,pune,kolkata,chennai]
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
ELECTORS = {"hyderabad": "Telangana", "mumbai": "Maharashtra", "pune": "Maharashtra", "kolkata": "West Bengal", "chennai": "Tamil Nadu"}
MIN_INSIDE, CAP = 0.95, 6
ROLLS = REPO / "data" / "realestate" / "gba_ward_electors_2026.csv"
ZONES = {"1": "Central", "2": "North", "3": "South", "4": "East", "5": "West"}   # ZONE_ID on the GBA roll table


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


def gba_electors(path=ROLLS):
    """{(body, ward_no): electors} from the transcribed GBA ward roll counts (zone, ward, male, female, others, total)."""
    import csv
    out = {}
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            out[(f"Bengaluru {ZONES[r['zone']]} City Corporation", str(int(r["ward"])))] = float(r["total"])
    return out


def calibrate(rows, ward_of, targets, vol20, vol10, area, cap=None):
    """Rewrite ``rows`` ({code: population fields}) in place for blocks whose ward has a census target.

    ward_of {code: ward key}; targets {ward key: population or electors}; vol20/vol10 {code: residential built volume},
    vol10 None for no growth factor; area(code) → km²; cap limits each ward's change against GHSL's own share.
    Returns the number of blocks rewritten.
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
        v20, v10 = sum(vol20.get(c) or 0 for c in cs), sum(vol10.get(c) or 0 for c in cs) if vol10 is not None else 0
        weight[w] = targets[w] * (min(v20 / v10, 3) if v10 else 1)
    if cap:
        ghsl = {w: sum(rows[c].get("population") or 0 for c in cs) for w, cs in by_ward.items()}
        sw = sum(weight.values())
        for w in weight:
            if ghsl[w] > 0:
                f = (weight[w] / sw) / (ghsl[w] / total)
                weight[w] = ghsl[w] / total * sw * min(max(f, 1 / cap), cap)
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


def _seats(region, root=CELLS):
    """{code: (AC number, AC name)} from the constituencies dataset."""
    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "constituencies")
    t = store.read_region(root, next(r for r in ds["regions"] if r["name"] == region))
    return {c: (int(n), a) for c, n, a in zip(t.codes, t.columns["ac_no"], t.columns["assembly"]) if n is not None and n == n and a}


def elector_targets(seat_of, segs, state, shares):
    """({code: AC number}, {AC number: 2024 electors}) for seats inside the region and matched by number and name."""
    from pipeline.realestate.elections import best, norm
    same = lambda a, b: best(a, [(b, True)]) or norm(a).startswith(norm(b)) or norm(b).startswith(norm(a))
    by_no = {no: (name, s["electors"]) for (no, name, st), s in segs.items() if st == state and s.get("electors")}
    ok = {}
    for no, name in set(seat_of.values()):
        if no in by_no and shares.get(no, 0) >= MIN_INSIDE and same(name, by_no[no][0]):
            ok[no] = by_no[no][1]
    return {c: v[0] for c, v in seat_of.items() if v[0] in ok}, ok


def calibrate_region(region, rows):
    """Rescale a freshly baked population ``rows`` dict for ``region`` (no-op outside CITIES and ELECTORS)."""
    if region not in CITIES and region not in ELECTORS:
        return 0
    from pipeline.cells import earthengine as gee
    v20, v10 = _volumes(region)
    if region in CITIES:
        return calibrate(rows, _wards(region), gba_electors(), v20, None, gee.cell_area_km2)
    from pipeline.realestate.constituencies import seat_shares
    from pipeline.realestate.elections import SEGMENTS, _csv, parse_segments
    segs = parse_segments(_csv(SEGMENTS))
    seat_of, electors = elector_targets(_seats(region), segs, ELECTORS[region], seat_shares(region, segs))
    return calibrate(rows, seat_of, electors, v20, None, gee.cell_area_km2, cap=CAP)


def main(argv=None):
    from pipeline.cells import store
    from pipeline.cells.ee_layers import population
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    for region in ap.parse_args(argv).region.split(","):
        spec, table = population(region)          # population() calls calibrate_region itself
        info = store.write_dataset(CELLS, spec, region, table, parquet=False)
        print(f"{region}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
