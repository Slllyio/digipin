"""Where a city's people have friends: Meta's Social Connectedness Index (Bailey et al., 2025 release, via HDX, public domain).

The Social Connectedness Index (SCI) is the relative probability that a Facebook user in one place is friends with a
user in another, from an anonymised snapshot of all active users; it is scaled so that values compare across pairs.
Strong ties between a city and a far-away district usually mean migration: people who moved and kept their friends. For
each city's district (GADM 4.1 level 2: Bangalore, Mumbai City + Mumbai Suburban averaged, Chennai, and so on; Delhi is
one unit) this module takes:

    * the districts outside the city's home state it is most connected to (top ``TOP``),
    * the countries it is most connected to (``gadm2_to_country``), and the countries where its tie is the most above
      the median Indian district's tie (only countries with a city SCI of ``MIN_ABROAD`` or more, to skip tiny states).

The lists are names, so they go into the lens file as a small table (``--js`` prints it); the cells get three numbers
per city (dataset ``social_ties``, copied to every lived-in L7 block):

    st_top_out_sci     SCI with the most-connected district outside the home state
    st_gulf_sci        mean SCI with the six Gulf states (UAE, Saudi Arabia, Kuwait, Qatar, Oman, Bahrain)
    st_abroad_ratio    the largest city-over-median-district ratio among countries with SCI >= MIN_ABROAD

Inputs are the India rows of the district file (``gadm2_shard_JO.csv`` in ``gadm2.zip``, rows with user_country IN),
the district-to-country file and the GADM 4.1 India level 2 names (used for names only; no GADM shapes are kept).

    python -m pipeline.realestate.socialties --rows in_rows.csv --countries ind_r2c.csv --gadm gadm41_IND_2.json [--js]
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import re
import statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
TOP = 5
MIN_ABROAD = 5000
GULF = ("AE", "SA", "KW", "QA", "OM", "BH")
COUNTRY = {"AE": "the UAE", "AU": "Australia", "BD": "Bangladesh", "BH": "Bahrain", "BN": "Brunei", "BT": "Bhutan", "CA": "Canada",
           "GB": "the UK", "IE": "Ireland", "KW": "Kuwait", "LK": "Sri Lanka", "LU": "Luxembourg", "MU": "Mauritius", "MV": "the Maldives",
           "MY": "Malaysia", "NP": "Nepal", "NZ": "New Zealand", "OM": "Oman", "PK": "Pakistan", "QA": "Qatar", "SA": "Saudi Arabia",
           "SG": "Singapore", "SO": "Somalia", "US": "the US"}
# region -> GADM 4.1 level-2 ids of the city's district(s)
CITY = {
    "ahmedabad": ["IND.11.1_1"], "bengaluru": ["IND.16.3_1"], "bhopal": ["IND.19.9_1"], "chennai": ["IND.31.2_1"],
    "delhi": ["IND.25.1_1"], "guna": ["IND.19.19_1"], "hyderabad": ["IND.32.2_1"], "indore_pilot": ["IND.19.23_1"],
    "jaipur": ["IND.29.17_1"], "kolkata": ["IND.36.11_1"], "lucknow": ["IND.34.49_1"],
    "mumbai": ["IND.20.17_1", "IND.20.18_1"], "pune": ["IND.20.26_1"],
}


FIX = {"NCTofDelhi": "Delhi", "AndamanandNicobar": "Andaman and Nicobar", "DadraandNagarHaveli": "Dadra and Nagar Haveli",
       "DamanandDiu": "Daman and Diu", "JammuandKashmir": "Jammu and Kashmir"}


def _split(name):
    """GADM run-together names ('MumbaiSuburban', 'NCTofDelhi') -> 'Mumbai Suburban', 'Delhi'."""
    if name in FIX:
        return FIX[name]
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)


def domestic(rows, city_ids, state):
    """rows [(user_region, friend_region, sci)] with friend in India -> {friend_region: mean sci over the city's ids}."""
    want = set(city_ids)
    out = collections.defaultdict(float)
    for ur, fr, s in rows:
        if ur in want:
            out[fr] += s / len(city_ids)
    return out


def ties(dom, abroad, median, home, state, names, top=TOP, min_abroad=MIN_ABROAD):
    """Summaries for one city. dom {district: sci}; abroad {country: sci}; median {country: median district sci}."""
    out_state = sorted(((d, v) for d, v in dom.items() if state.get(d) != home), key=lambda t: -t[1])[:top]
    countries = sorted(((c, v) for c, v in abroad.items() if c != "IN"), key=lambda t: -t[1])
    distinct = sorted(((c, v / median[c]) for c, v in abroad.items() if c != "IN" and v >= min_abroad and median.get(c)),
                      key=lambda t: -t[1])[:3]
    gulf = [abroad[c] for c in GULF if c in abroad]
    return {
        "districts": [[_split(names.get(d, d)), _split(state.get(d, "")), round(v)] for d, v in out_state],
        "countries": [[COUNTRY.get(c, c), round(v)] for c, v in countries[:top]],
        "distinct": [[COUNTRY.get(c, c), round(r, 1)] for c, r in distinct if r >= 2],
        "fields": {"st_top_out_sci": round(out_state[0][1]) if out_state else None,
                   "st_gulf_sci": round(sum(gulf) / len(gulf)) if gulf else None,
                   "st_abroad_ratio": round(distinct[0][1], 1) if distinct else None},
    }


def cell_dataset(region, fields):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    specs = [
        FieldSpec("st_top_out_sci", "Social connectedness with the most-connected district outside the home state", agg="max", unit="SCI", ramp="viridis", higher_is=None),
        FieldSpec("st_gulf_sci", "Mean social connectedness with the six Gulf states", agg="max", unit="SCI", ramp="viridis", higher_is=None),
        FieldSpec("st_abroad_ratio", "Strongest tie abroad relative to the median Indian district", agg="max", unit="×", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="social_ties", title="Where the city's people have friends (Meta Social Connectedness Index)", level=LEVEL, fields=specs,
        group="Real estate",
        description="Meta's Social Connectedness Index (2025 release, via HDX, public domain): the relative probability that "
                    "Facebook users in the city's district and in another district or country are friends. One value per city.",
        source="pipeline/realestate/socialties.py (Social Connectedness Index gadm2 and gadm2_to_country files via HDX)",
        license="Public domain (Meta Data for Good Social Connectedness Index via data.humdata.org)", default_field="st_top_out_sci",
        extrude=False)
    clean = {k: v for k, v in fields.items() if v is not None}
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **clean} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--rows", required=True, help="India rows of the gadm2 SCI file")
    ap.add_argument("--countries", required=True, help="India rows of gadm2_to_country.csv")
    ap.add_argument("--gadm", required=True, help="gadm41_IND_2.json (names only)")
    ap.add_argument("--js", action="store_true", help="print the lens table")
    a = ap.parse_args(argv)
    names, state = {}, {}
    for f in json.load(open(a.gadm))["features"]:
        p = f["properties"]
        names[p["GID_2"]], state[p["GID_2"]] = p["NAME_2"], p["NAME_1"]
    want = {g for ids in CITY.values() for g in ids}
    rows = []
    with open(a.rows, newline="") as f:
        for u, fc, ur, fr, s in csv.reader(f):
            if fc == "IN" and ur in want:
                rows.append((ur, fr, int(s)))
    by = collections.defaultdict(dict)
    with open(a.countries, newline="") as f:
        for u, fc, ur, fr, s in csv.reader(f):
            if u == "IN":
                by[ur][fc] = int(s)
    allc = {c for d in by.values() for c in d}
    median = {c: statistics.median([d.get(c, 0) for d in by.values()]) for c in allc}
    table = {}
    for region, ids in CITY.items():
        abroad = collections.defaultdict(float)
        for g in ids:
            for c, v in by.get(g, {}).items():
                abroad[c] += v / len(ids)
        t = ties(domestic(rows, ids, state), abroad, median, state[ids[0]], state, names)
        info = cell_dataset(region, t.pop("fields"))
        table[region] = t
        print(region, t["districts"][:3], t["countries"][:3], t["distinct"], info["cells"], "blocks")
    if a.js:
        print("const TIES = " + json.dumps(table, separators=(",", ":"), ensure_ascii=False) + ";")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
