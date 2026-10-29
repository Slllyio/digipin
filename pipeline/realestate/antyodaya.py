"""Basic services in the fringe villages (Bengaluru, Pune; Mission Antyodaya 2020 via OpenCity, public domain).

Mission Antyodaya's 2020 survey scored every rural village and habitation on its services: piped water, drains,
roads, buses, power, health, schools and housing. The city's edge is still rural on paper, so these villages are where
the city is spreading next. Survey rows carry the 2011 village code but the village maps on OpenCity do not, so rows
are matched to the ``villages`` dataset by village name (spelling-normalised; close spellings allowed when the first two
letters agree) in the same tehsil; several rows of
one village are summed. Villages whose surveyed households hold under a fifth of today's residents (GHSL) are dropped:
the city has swallowed them and the survey only counts a rural remnant. Each L7 block in a matched village (outside town limits) carries the village's figures
(dataset ``village_services``):

    ma_village_no      the block's village_id from ``villages``, for lenses that group by village
    ma_households      households surveyed in the village
    ma_piped_pct       households with a piped water connection (%)
    ma_kuccha_pct      households in a kuccha house (mud walls and roof) (%)
    ma_no_latrine_pct  households without a sanitary latrine (%)
    ma_bpl_pct         households holding a BPL ration card (%)
    ma_drain           drainage: 1 closed, 2 open and covered, 3 open pucca, 4 open kuccha, 5 none (households' worst-weighted)
    ma_waste           1 where the village has a community waste disposal system
    ma_bus             1 where a bus stops in the village
    ma_power_hours     hours of domestic power a day (band midpoint)
    ma_phc_km          distance to a primary or community health centre (band midpoint, km)

Only service and housing counts are read: names of people, minority, caste and scheme beneficiary lists are never parsed.

    python -m pipeline.realestate.antyodaya --region bengaluru,pune
"""
from __future__ import annotations

import argparse
import csv
import difflib
import io
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PACKAGE = "bengaluru-urban-antyodaya-data"
RESOURCE = {"bengaluru": "Bengaluru", "pune": "Pune", "ahmedabad": "Ahmedabad"}   # Ahmedabad: only 5 villages left rural in the city box
KEEP = ("village_name", "sub_district_name", "total_hhd", "total_hhd_having_piped_water_connection", "total_hhd_with_kuccha_wall_kuccha_roof",
        "total_hhd_not_having_sanitary_latrines", "total_hhd_having_bpl_cards", "availability_of_drainage_system",
        "is_community_waste_disposal_system", "availability_of_public_transport", "availablility_hours_of_domestic_electricity",
        "distance_of_phc_chc")
HOURS = {"1": 2, "2": 6, "3": 10, "4": 18, "5": 0}           # 1-4 h, 4-8 h, 8-12 h, >12 h, none
KM = {"0": 0, "1": 0.5, "2": 1.5, "3": 3.5, "4": 7.5, "5": 12}  # in the village, <1, 1-2, 2-5, 5-10, >10 km
HH_SIZE, MIN_COVER = 4.5, 0.2
_SUBS = (("halli", "hali"), ("ahali", "hali"), ("pura", "pur"), ("oo", "u"), ("ee", "i"), ("aa", "a"), ("th", "t"), ("dh", "d"),
         ("bh", "b"), ("kh", "k"), ("gh", "g"), ("w", "v"), ("y", "i"))


def norm(s):
    """'Byrappanahalli (Part)' -> 'birappanahali': spelling-normalised village name."""
    s = re.sub(r"[^a-z]", "", re.sub(r"\(.*?\)", "", str(s or "").lower()))
    for a, b in _SUBS:
        s = s.replace(a, b)
    return s


def _n(x):
    try:
        return max(float(x), 0.0)
    except (TypeError, ValueError):
        return 0.0


def _close(n, names, cutoff):
    """Closest name sharing the first two letters, for names of six letters or more (catches spelling, not neighbours)."""
    if len(n) < 6:
        return None
    pool = [m for m in names if m[:2] == n[:2] and abs(len(m) - len(n)) <= 2]
    return next(iter(difflib.get_close_matches(n, pool, 1, cutoff)), None)


def _same_tehsil(a, b):
    """Map and survey tehsils agree: equal, one a prefix of the other ('mulshi', 'mulshipaud'), or the map's district-wide
    'urban' tehsil, which the survey splits into North, East and Yelahanka."""
    return a == b or a.startswith(b) or b.startswith(a) or a.endswith("urban")


def match(rows, names, cutoff=0.935):
    """{(village, tehsil): [survey rows]} for rows whose name matches a map village.

    ``names`` holds (normalised village, normalised tehsil) pairs from the map; the tehsils must agree."""
    keys = {}
    for v, t in names:
        keys.setdefault(v, []).append((v, t))
    out = {}
    for r in rows:
        n, t = norm(r.get("village_name")), norm(r.get("sub_district_name"))
        v = n if n in keys else _close(n, keys, cutoff)
        if not v:
            continue
        own = [k for k in keys[v] if _same_tehsil(k[1], t)]
        key = own[0] if len(own) == 1 else None
        if key:
            out.setdefault(key, []).append(r)
    return out


def village(rows):
    """Figures for one map village from its survey rows (households summed, codes weighted by households)."""
    hh = sum(_n(r.get("total_hhd")) for r in rows)
    if hh < 10:
        return None
    w = lambda r: _n(r.get("total_hhd")) or 1
    tw = sum(w(r) for r in rows)
    pct = lambda k: round(min(100.0, 100 * sum(_n(r.get(k)) for r in rows) / hh), 1)

    def mean(k, table=None):
        xs = [((table or {}).get(str(r.get(k)).strip()) if table else _n(r.get(k)), w(r)) for r in rows]
        xs = [(v, wt) for v, wt in xs if v is not None and (table or v)]
        return round(sum(v * wt for v, wt in xs) / sum(wt for _, wt in xs), 1) if xs else None

    out = {
        "ma_households": int(hh),
        "ma_piped_pct": pct("total_hhd_having_piped_water_connection"),
        "ma_kuccha_pct": pct("total_hhd_with_kuccha_wall_kuccha_roof"),
        "ma_no_latrine_pct": pct("total_hhd_not_having_sanitary_latrines"),
        "ma_bpl_pct": pct("total_hhd_having_bpl_cards"),
        "ma_drain": mean("availability_of_drainage_system", {str(k): k for k in range(1, 6)}),
        "ma_waste": round(sum(w(r) for r in rows if str(r.get("is_community_waste_disposal_system")).strip() == "1") / tw),
        "ma_bus": round(sum(w(r) for r in rows if str(r.get("availability_of_public_transport")).strip() == "1") / tw),
        "ma_power_hours": mean("availablility_hours_of_domestic_electricity", HOURS),
        "ma_phc_km": mean("distance_of_phc_chc", KM),
    }
    return {k: v for k, v in out.items() if v is not None}


def village_cells(region, root=CELLS):
    """{(normalised village, normalised tehsil): [(code, village_id)]} for lived-in blocks outside town limits."""
    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "villages")
    t = store.read_region(root, next(r for r in ds["regions"] if r["name"] == region))
    out = {}
    for c, v, te, vid, town in zip(t.codes, t.columns["village"], t.columns["tehsil"], t.columns["village_id"], t.columns["in_town"]):
        if v and not town:
            out.setdefault((norm(v), norm(te)), []).append((c, vid))
    return out


def residents(region, root=CELLS):
    """{code: GHSL residents} for the region."""
    from pipeline.cells import store
    cat = json.loads((root / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "population")
    t = store.read_region(root, next(r for r in ds["regions"] if r["name"] == region))
    return dict(zip(t.codes, t.columns["population"]))


def covered(fig, blocks, pop, share=MIN_COVER):
    """True when the survey's households hold at least ``share`` of the village's residents today: villages swallowed
    by the city keep a token rural remnant in the survey (Pimple Saudagar: 100 households for a lakh of residents)."""
    people = sum(pop.get(c) or 0 for c, _ in blocks)
    return not people or fig["ma_households"] * HH_SIZE >= share * people


def records(cells, vs):
    for key, fig in vs.items():
        for code, vid in cells.get(key, ()):
            yield {"digipin": code, **({"ma_village_no": int(vid)} if vid is not None else {}), **fig}


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("ma_village_no", "Village number (villages dataset)", agg="min", ramp="viridis", higher_is=None),
        FieldSpec("ma_households", "Households in the village, 2020", agg="max", unit="households", ramp="viridis", higher_is=None),
        FieldSpec("ma_piped_pct", "Village households with a piped water connection", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is="better"),
        FieldSpec("ma_kuccha_pct", "Village households in a kuccha house", agg="mean", unit="%", domain=[0, 20], ramp="viridis", higher_is="worse"),
        FieldSpec("ma_no_latrine_pct", "Village households without a sanitary latrine", agg="mean", unit="%", domain=[0, 20], ramp="viridis", higher_is="worse"),
        FieldSpec("ma_bpl_pct", "Village households with a BPL card", agg="mean", unit="%", domain=[0, 80], ramp="viridis", higher_is=None),
        FieldSpec("ma_drain", "Village drainage (1 closed ... 5 none)", agg="mean", unit="code", domain=[1, 5], ramp="viridis", higher_is="worse"),
        FieldSpec("ma_waste", "Village has community waste disposal", agg="max", unit="yes = 1", domain=[0, 1], ramp="viridis", higher_is="better"),
        FieldSpec("ma_bus", "A bus stops in the village", agg="max", unit="yes = 1", domain=[0, 1], ramp="viridis", higher_is="better"),
        FieldSpec("ma_power_hours", "Domestic power a day in the village", agg="mean", unit="hours", domain=[0, 18], ramp="viridis", higher_is="better"),
        FieldSpec("ma_phc_km", "Distance from the village to a health centre", agg="mean", unit="km", domain=[0, 12], ramp="viridis", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="village_services", title="Services in the fringe villages (Mission Antyodaya 2020)", level=LEVEL, fields=specs, group="Real estate",
        description="Mission Antyodaya's 2020 village survey (Ministry of Rural Development, via data.opencity.in) for the "
                    "rural villages at the city's edge: piped water, housing, latrines, drains, waste, buses, power and the "
                    "nearest health centre. Survey rows are matched to the Survey of India village map by name; every "
                    "lived-in block of a matched village outside town limits carries the village's figures.",
        source="pipeline/realestate/antyodaya.py (OpenCity Mission Antyodaya 2020)",
        license="Public domain (Ministry of Rural Development via data.opencity.in)", default_field="ma_piped_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru,pune")
    regions = ap.parse_args(argv).region.split(",")
    res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PACKAGE}, timeout=60).json()["result"]["resources"]
    for region in regions:
        url = next(r["url"] for r in res if r["format"] == "CSV" and RESOURCE[region] in r["name"])
        text = requests.get(url, timeout=180).content.decode("utf-8-sig")
        rows = [{k: r.get(k) for k in KEEP} for r in csv.DictReader(io.StringIO(text))]
        cells = village_cells(region)
        pop = residents(region)
        vs = {k: f for k, f in ((k, village(rs)) for k, rs in match(rows, list(cells)).items()) if f and covered(f, cells[k], pop)}
        info = cell_dataset(region, list(records(cells, vs)))
        print(f"{region}: {len(rows)} survey rows, {len(vs)} of {len(cells)} map villages matched, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
