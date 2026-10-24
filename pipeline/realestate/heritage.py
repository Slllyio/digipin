"""Protected monuments and heritage buildings per block, with the ASI construction limits around them.

Monuments come from Wikidata (CC0): items in India with a heritage designation (P1435) and
coordinates. Monuments of National Importance are protected by the Ancient Monuments and
Archaeological Sites and Remains (AMASR) Act 1958, amended 2010: no new construction within
100 m of the protected limits (prohibited area) and only with National Monuments Authority
permission, under height limits, from 100 m to 300 m (regulated area).

Per L7 block (dataset ``heritage``):

    national        Monuments of National Importance in the block
    state           State Protected Monuments in the block
    local           other heritage listings (municipal heritage grades, UNESCO parts, railway heritage)
    prohibited_pct  share of the block within PROHIBITED_M of a national monument point
    regulated_pct   share within REGULATED_M but beyond PROHIBITED_M
    monument_m      distance from the block centre to the nearest national monument

Wikidata gives one point per monument, not its protected boundary, so the zones are measured
from that point and understate the limits around large sites such as forts.

    python -m pipeline.realestate.heritage --region all
"""
from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NATIONAL, STATE = "Q17047513", "Q17047640"
PROHIBITED_M, REGULATED_M = 100, 300
SAMPLES = 8          # SAMPLES × SAMPLES points per block for zone shares
SPARQL = "https://query.wikidata.org/sparql"
M_LAT = 110_574.0


def query(region):
    """[(qid, label, lat, lng, kind)] for designated heritage items in the region's bounding box."""
    w, s, e, n = bbox_for(region)
    q = f"""
        SELECT ?m ?mLabel ?c ?d WHERE {{
          ?m wdt:P1435 ?d; wdt:P17 wd:Q668.
          SERVICE wikibase:box {{ ?m wdt:P625 ?c. bd:serviceParam wikibase:cornerSouthWest "Point({w} {s})"^^geo:wktLiteral;
                                                  wikibase:cornerNorthEast "Point({e} {n})"^^geo:wktLiteral. }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
        }}"""
    req = urllib.request.Request(f"{SPARQL}?{urllib.parse.urlencode({'query': q})}",
                                 headers={"Accept": "application/sparql-results+json", "User-Agent": "DigiPinResearch/1.0 (open data)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        rows = json.load(r)["results"]["bindings"]
    return parse(rows)


def parse(bindings):
    """SPARQL bindings → one (qid, label, lat, lng, kind) per item, kind the strongest designation it holds."""
    rank = {"national": 0, "state": 1, "local": 2}
    best = {}
    for b in bindings:
        qid = b["m"]["value"].rsplit("/", 1)[-1]
        lng, lat = (float(x) for x in b["c"]["value"].removeprefix("Point(").rstrip(")").split())
        d = b["d"]["value"].rsplit("/", 1)[-1]
        kind = "national" if d == NATIONAL else "state" if d == STATE else "local"
        if qid not in best or rank[kind] < rank[best[qid][4]]:
            best[qid] = (qid, b.get("mLabel", {}).get("value", qid), lat, lng, kind)
    return list(best.values())


def _m(lat0):
    return 111_320.0 * math.cos(math.radians(lat0)), M_LAT


def zone_shares(bounds, monuments):
    """(prohibited share, regulated share, distance m from the centre to the nearest monument) for one block."""
    lat0 = (bounds["south"] + bounds["north"]) / 2
    mx, my = _m(lat0)
    cx = (bounds["west"] + bounds["east"]) / 2
    dists = [(math.hypot((cx - lng) * mx, (lat0 - lat) * my), lat, lng) for lat, lng in monuments]
    near = min(d for d, _, _ in dists)
    half = math.hypot((bounds["east"] - bounds["west"]) * mx, (bounds["north"] - bounds["south"]) * my) / 2
    close = [(lat, lng) for d, lat, lng in dists if d <= REGULATED_M + half]
    if not close:
        return 0.0, 0.0, near
    pro = reg = 0
    for i in range(SAMPLES):
        for j in range(SAMPLES):
            x = bounds["west"] + (bounds["east"] - bounds["west"]) * (i + 0.5) / SAMPLES
            y = bounds["south"] + (bounds["north"] - bounds["south"]) * (j + 0.5) / SAMPLES
            d = min(math.hypot((x - lng) * mx, (y - lat) * my) for lat, lng in close)
            pro += d <= PROHIBITED_M
            reg += PROHIBITED_M < d <= REGULATED_M
    n = SAMPLES * SAMPLES
    return 100 * pro / n, 100 * reg / n, near


def rows_for(region, items):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next((r for r in pop["regions"] if r["name"] == region), None)
    if entry is None:
        return []
    nat = [(lat, lng) for _, _, lat, lng, k in items if k == "national"]
    counts = {}
    for _, _, lat, lng, kind in items:
        code = store.cell_code(LEVEL, lat, lng)
        if code:
            counts.setdefault(code, {"national": 0, "state": 0, "local": 0})[kind] += 1
    rows = []
    for code in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(code)
        c = counts.get(code, {"national": 0, "state": 0, "local": 0})
        row = {"digipin": code, **c}
        if nat:
            # Only blocks near a monument need the sampled shares.
            pro, reg, near = zone_shares(b, nat)
            if near > 5000 and not any(c.values()):
                continue
            row.update(prohibited_pct=round(pro, 1), regulated_pct=round(reg, 1), monument_m=round(near))
        elif not any(c.values()):
            continue
        rows.append(row)
    return rows


def cell_dataset(region, rows, n_items):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("national", "Monuments of National Importance (ASI) in the block", agg="sum", unit="count", ramp="heat"),
        FieldSpec("state", "State Protected Monuments in the block", agg="sum", unit="count", ramp="heat"),
        FieldSpec("local", "Other heritage listings in the block (municipal grades, UNESCO parts, railway heritage)", agg="sum",
                  unit="count", ramp="heat"),
        FieldSpec("prohibited_pct", f"Within {PROHIBITED_M} m of a national monument (AMASR prohibited area)", agg="mean",
                  unit="% of block", domain=[0, 100], ramp="reds", higher_is=None),
        FieldSpec("regulated_pct", f"{PROHIBITED_M}–{REGULATED_M} m from a national monument (AMASR regulated area)", agg="mean",
                  unit="% of block", domain=[0, 100], ramp="heat", higher_is=None),
        FieldSpec("monument_m", "Distance to the nearest national monument", agg="min", unit="m", domain=[0, 5000], ramp="viridis",
                  higher_is=None),
    ]
    spec = DatasetSpec(
        id="heritage", title="Protected monuments and ASI limits", level=LEVEL, fields=specs, group="Real estate",
        description=f"Wikidata items in India with a heritage designation and coordinates ({n_items} in this city's box): Monuments of "
                    "National Importance, State Protected Monuments and other listings. Under the AMASR Act (amended 2010) no new "
                    f"construction is allowed within {PROHIBITED_M} m of a national monument's protected limits, and from "
                    f"{PROHIBITED_M} to {REGULATED_M} m it needs National Monuments Authority permission with height limits. Zones "
                    "here are drawn from Wikidata's single point per monument, not the notified boundary, so they understate the "
                    "limits around large sites; confirm with the ASI circle or NMA before buying or building.",
        source="pipeline/realestate/heritage.py (Wikidata SPARQL, P1435 heritage designation)",
        license="CC0 1.0 (Wikidata)", default_field="prohibited_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        items = query(r)
        rows = rows_for(r, items)
        k = {t: sum(1 for x in items if x[4] == t) for t in ("national", "state", "local")}
        print(f"{r}: {k['national']} national, {k['state']} state, {k['local']} other heritage; {len(rows)} blocks")
        if rows:
            cell_dataset(r, rows, len(items))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
