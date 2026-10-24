"""Metro stations to come, the value they should add, and what past openings did to building.

Stations come from Wikidata (metro stations in India with coordinates):
opening dates (P1619) and state of use (P5817: under construction,
proposed). The snapshot is kept in data/realestate/metro_stations.json so
bakes work offline; ``--refresh`` re-queries.

Per L7 block (dataset ``metro_future``), where an upcoming station shortens
the walk to metro:

    future_walk_min    walk to the nearest upcoming station (straight line ×
                       1.3 detour at 4.8 km/h, as pipeline/traffic/rail_stations.py)
    walk_saved_min     minutes saved against today's metro_walk_min
    value_uplift_pct   change in the land-value model's metro premium
                       (pipeline/realestate/land_value.py metro_premium)

Evidence (data/realestate/metro_effect.json): blocks within 800 m of
stations that opened 2017–2022, with no older station within 2 km, against
blocks 1.5–3 km from the same stations. Outcome: floor area added 2016–2023
(Open Buildings 2.5D Temporal, re_supply.new_floor_m2).

    python -m pipeline.realestate.metro_future --region all [--refresh]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics as st
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.realestate import land_value as lv

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
OUT = REPO / "data" / "realestate"
SNAPSHOT = OUT / "metro_stations.json"
EFFECT = OUT / "metro_effect.json"
LEVEL = 7
WALK_M_PER_MIN, DETOUR, MAX_WALK = 80.0, 1.3, 20.0
NEAR_KM, RING_KM, OLD_KM, MIN_BUILT = 0.8, (1.5, 3.0), 2.0, 10
EVENT_YEARS = (2017, 2022)
RECENT_FROM = 2025          # opened this year or later: may be missing from the Overture station layer
SPARQL = "https://query.wikidata.org/sparql"
UNDER_CONSTRUCTION, PROPOSED = "Q12377751", "Q811683"
QUERY = """SELECT ?s ?sLabel ?c (MIN(?d) AS ?open) (SAMPLE(?state) AS ?st) WHERE {
  ?s wdt:P31/wdt:P279* wd:Q928830; wdt:P17 wd:Q668; wdt:P625 ?c.
  OPTIONAL { ?s wdt:P1619 ?d } OPTIONAL { ?s wdt:P5817 ?state }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?s ?sLabel ?c"""


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def km(lat1, lng1, lat2, lng2):
    return math.hypot((lat1 - lat2) * 111.0, (lng1 - lng2) * 111.0 * math.cos(math.radians(lat1)))


def walk_min(dist_km):
    return dist_km * 1000 * DETOUR / WALK_M_PER_MIN


def uplift_pct(now_min, future_min):
    """Percent value change when the metro walk drops from now_min to future_min."""
    gain = lv.metro_premium(future_min) - lv.metro_premium(now_min)
    return 100 * (math.exp(gain) - 1) if gain > 0 else 0.0


def parse_rows(bindings):
    """Wikidata SPARQL bindings → [{id, name, lat, lng, open, state}]."""
    out = []
    for b in bindings:
        nums = re.findall(r"[-\d.]+", b["c"]["value"])
        if len(nums) < 2:
            continue
        state = b.get("st", {}).get("value", "").rsplit("/", 1)[-1]
        opened = b.get("open", {}).get("value", "")[:4]
        out.append({"id": b["s"]["value"].rsplit("/", 1)[-1], "name": b.get("sLabel", {}).get("value", ""),
                    "lat": round(float(nums[1]), 6), "lng": round(float(nums[0]), 6),
                    "open": int(opened) if opened.isdigit() else None,
                    "state": {UNDER_CONSTRUCTION: "under_construction", PROPOSED: "proposed"}.get(state, "in_use" if opened else "")})
    return sorted(out, key=lambda r: r["id"])


def upcoming(stations):
    return [s for s in stations if s["state"] in ("under_construction", "proposed")
            or (s["open"] is not None and s["open"] >= RECENT_FROM)]


# ── data ────────────────────────────────────────────────────────────────────

def fetch_stations(refresh=False, log=print):
    if SNAPSHOT.exists() and not refresh:
        return json.loads(SNAPSHOT.read_text())["stations"]
    url = SPARQL + "?" + urllib.parse.urlencode({"query": QUERY})
    req = urllib.request.Request(url, headers={"Accept": "application/sparql-results+json",
                                               "User-Agent": "digipin-research/1.0 (https://github.com/slllyio/digipin)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        rows = parse_rows(json.load(r)["results"]["bindings"])
    SNAPSHOT.write_text(json.dumps({"source": "Wikidata (CC0): metro stations in India, P625/P1619/P5817",
                                    "fetched": datetime.now(UTC).date().isoformat(), "stations": rows}, indent=1) + "\n")
    log(f"{len(rows)} stations from Wikidata")
    return rows


def _in(region, s):
    b = bbox_for(region)
    w, so, e, n = (b["west"], b["south"], b["east"], b["north"]) if isinstance(b, dict) else b
    return w <= s["lng"] <= e and so <= s["lat"] <= n


def event_study(region, stations):
    """Floor area added 2016–23 near stations opened in EVENT_YEARS vs a 1.5–3 km ring. None if too few."""
    sts = [s for s in stations if _in(region, s) and s["open"]]
    new = [s for s in sts if EVENT_YEARS[0] <= s["open"] <= EVENT_YEARS[1]]
    old = [s for s in sts if s["open"] < EVENT_YEARS[0]]
    if len(new) < 3:
        return None
    nf, _ = lv._col("re_supply", "new_floor_m2", region)
    bu, _ = lv._col("built_up", "built_pct", region)
    if not nf:
        return None
    near, ring = [], []
    for code, v in nf.items():
        if bu and (bu.get(code) or 0) < MIN_BUILT:
            continue
        c = digipin.decode_partial(code)
        if min((km(c["lat"], c["lng"], s["lat"], s["lng"]) for s in old), default=99) < OLD_KM:
            continue
        dn = min(km(c["lat"], c["lng"], s["lat"], s["lng"]) for s in new)
        dany = min(km(c["lat"], c["lng"], s["lat"], s["lng"]) for s in sts if s["open"] <= 2023)
        if dn <= NEAR_KM:
            near.append(v or 0)
        elif RING_KM[0] <= dn <= RING_KM[1] and dany >= RING_KM[0]:
            ring.append(v or 0)
    if len(near) < 10 or len(ring) < 10:
        return None
    return {"stations": len(new), "near_cells": len(near), "ring_cells": len(ring),
            "near_m2": round(st.mean(near)), "ring_m2": round(st.mean(ring)), "ratio": round(st.mean(near) / st.mean(ring), 2),
            "_near": near, "_ring": ring}


def write_effect(results):
    near = [v for r in results.values() for v in r["_near"]]
    ring = [v for r in results.values() for v in r["_ring"]]
    pooled = None
    if near and ring:
        se = math.sqrt(st.variance(near) / len(near) + st.variance(ring) / len(ring))
        mr = st.mean(ring)
        pooled = {"near_cells": len(near), "ring_cells": len(ring), "near_m2": round(st.mean(near)), "ring_m2": round(mr),
                  "ratio": round(st.mean(near) / mr, 2), "ratio_ci95": round(1.96 * se / mr, 2)}
    EFFECT.write_text(json.dumps({
        "method": f"Mean floor area added 2016–2023 per L7 block (Open Buildings 2.5D Temporal) within {NEAR_KM} km of metro "
                  f"stations opened {EVENT_YEARS[0]}–{EVENT_YEARS[1]} (Wikidata P1619), against blocks {RING_KM[0]}–{RING_KM[1]} km "
                  f"from them; both at least {OLD_KM} km from older stations and at least {MIN_BUILT}% built up.",
        "pooled": pooled, "cities": {k: {x: y for x, y in v.items() if not x.startswith("_")} for k, v in results.items()},
    }, indent=1, ensure_ascii=False) + "\n")
    return pooled


def compute(region, stations, log=print):
    up = [s for s in upcoming(stations) if _in(region, s)]
    if not up:
        log(f"{region}: no upcoming stations on Wikidata")
        return {}
    walk, _ = lv._col("rail_access", "metro_walk_min", region)
    if not walk:
        return {}
    rows = {}
    for code, now in walk.items():
        c = digipin.decode_partial(code)
        fut = min(walk_min(km(c["lat"], c["lng"], s["lat"], s["lng"])) for s in up)
        now = now if now is not None else 999.0
        if fut >= min(now, MAX_WALK):
            continue
        rows[code] = {"future_walk_min": round(fut, 1), "walk_saved_min": round(min(now, 120) - fut, 1),
                      "value_uplift_pct": round(uplift_pct(now, fut), 2)}
    log(f"{region}: {len(up)} upcoming stations, {len(rows)} blocks gain")
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("future_walk_min", "Walk to the nearest upcoming metro station", agg="mean", unit="min", domain=[0, 20],
                  ramp="viridis", higher_is="worse"),
        FieldSpec("walk_saved_min", "Minutes saved on the walk to metro", agg="mean", unit="min", domain=[0, 30],
                  ramp="greens", higher_is="better"),
        FieldSpec("value_uplift_pct", "Expected land value uplift from the new station", agg="mean", unit="%",
                  domain=[0, 10], ramp="greens", higher_is=None),
    ]
    spec = DatasetSpec(
        id="metro_future", title="Upcoming metro stations", level=LEVEL, fields=specs, group="Real estate",
        description="Blocks whose walk to metro shortens when stations under construction or proposed (Wikidata) open, "
                    "and the land-value model's metro premium gained (up to +10% within a 6-minute walk). Wikidata "
                    "lists upcoming stations for some cities only.",
        source="pipeline/realestate/metro_future.py (Wikidata metro stations, rail_access, land_value metro premium)",
        license="CC0 (Wikidata); derived", default_field="value_uplift_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    p.add_argument("--refresh", action="store_true", help="re-query Wikidata")
    a = p.parse_args(argv)
    stations = fetch_stations(a.refresh)
    regions = list(CITY_PILOTS) if a.region == "all" else a.region.split(",")
    effects = {}
    for r in regions:
        e = event_study(r, stations)
        if e:
            effects[r] = e
        rows = compute(r, stations)
        if rows:
            cell_dataset(r, rows)
    if a.region == "all" and effects:
        print(json.dumps(write_effect(effects)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
