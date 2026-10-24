"""Visitor landmarks per block from Wikidata, weighted by how widely each is written about.

Wikidata items with coordinates in the city's box that are visitor attractions (temples, mosques, gurdwaras,
churches, tombs, forts, museums, monuments, palaces, parks, zoos, lakes, beaches, markets, stadiums and the
like) and have articles in at least MIN_SITELINKS Wikipedia languages. The number of language editions
(sitelinks) is a simple, open proxy for how well known a place is, standing in for page views or footfall.

Per L7 block (dataset ``landmarks``):

    landmarks   visitor landmarks in the block
    pull        sum of their sitelinks (language editions)
    top_pull    sitelinks of the best-known landmark in the block

    python -m pipeline.realestate.landmarks --region all
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
MIN_SITELINKS = 3
SPARQL = "https://query.wikidata.org/sparql"
# Wikidata classes (P31) that draw visitors.
ATTRACTIONS = {
    "Q570116": "tourist attraction", "Q32815": "mosque", "Q842402": "Hindu temple", "Q44539": "temple", "Q337986": "gurdwara",
    "Q16970": "church", "Q2977": "cathedral", "Q5393308": "Buddhist temple", "Q2088357": "Jain temple", "Q697295": "shrine",
    "Q162875": "mausoleum", "Q381885": "tomb", "Q1785071": "fort", "Q53060": "gate", "Q4989906": "monument", "Q5003624": "memorial",
    "Q33506": "museum", "Q17431399": "national museum", "Q207694": "art museum", "Q16560": "palace", "Q839954": "archaeological site",
    "Q1081138": "historic site", "Q22698": "park", "Q1107656": "garden", "Q43501": "zoo", "Q167346": "botanical garden",
    "Q23397": "lake", "Q40080": "beach", "Q37654": "market", "Q11315": "shopping mall", "Q483110": "stadium", "Q682943": "cricket field",
    "Q1137809": "stepwell", "Q2319498": "landmark", "Q12518": "tower", "Q24398318": "religious building", "Q1007870": "art gallery",
    "Q153562": "opera house", "Q24354": "theatre", "Q2416723": "theme park", "Q12280": "bridge",
}


def query(region):
    """[(qid, lat, lng, sitelinks)] for visitor attractions in the region's box."""
    w, s, e, n = bbox_for(region)
    values = " ".join(f"wd:{q}" for q in ATTRACTIONS)
    q = f"""
        SELECT DISTINCT ?m ?c ?sl WHERE {{
          SERVICE wikibase:box {{ ?m wdt:P625 ?c. bd:serviceParam wikibase:cornerSouthWest "Point({w} {s})"^^geo:wktLiteral;
                                                  wikibase:cornerNorthEast "Point({e} {n})"^^geo:wktLiteral. }}
          ?m wikibase:sitelinks ?sl. FILTER(?sl >= {MIN_SITELINKS})
          VALUES ?t {{ {values} }} ?m wdt:P31 ?t.
        }}"""
    req = urllib.request.Request(f"{SPARQL}?{urllib.parse.urlencode({'query': q})}",
                                 headers={"Accept": "application/sparql-results+json", "User-Agent": "DigiPinResearch/1.0 (open data)"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return parse(json.load(r)["results"]["bindings"])
        except OSError:
            if attempt == 2:
                raise
            time.sleep(10 * (attempt + 1))
    return []


def parse(bindings):
    """SPARQL bindings → one (qid, lat, lng, sitelinks) per item."""
    out = {}
    for b in bindings:
        qid = b["m"]["value"].rsplit("/", 1)[-1]
        lng, lat = (float(x) for x in b["c"]["value"].removeprefix("Point(").rstrip(")").split())
        out.setdefault(qid, (qid, lat, lng, int(b["sl"]["value"])))
    return list(out.values())


def rows_for(items):
    from pipeline.cells import store
    agg = {}
    for _, lat, lng, sl in items:
        code = store.cell_code(LEVEL, lat, lng)
        if not code:
            continue
        a = agg.setdefault(code, {"landmarks": 0, "pull": 0, "top_pull": 0})
        a["landmarks"] += 1
        a["pull"] += sl
        a["top_pull"] = max(a["top_pull"], sl)
    return [{"digipin": code, **a} for code, a in agg.items()]


def cell_dataset(region, rows, n_items):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("landmarks", "Visitor landmarks in the block", agg="sum", unit="count", domain=[0, 3], ramp="heat", higher_is=None),
        FieldSpec("pull", "Landmark pull (Wikipedia language editions, summed)", agg="sum", unit="editions", domain=[0, 60], ramp="heat",
                  higher_is=None),
        FieldSpec("top_pull", "Best-known landmark's Wikipedia language editions", agg="max", unit="editions", domain=[0, 60], ramp="heat",
                  higher_is=None),
    ]
    spec = DatasetSpec(
        id="landmarks", title="Visitor landmarks (Wikidata)", level=LEVEL, fields=specs, group="Real estate",
        description=f"Wikidata items in this city's box ({n_items}) that are visitor attractions (places of worship, tombs, forts, "
                    "museums, monuments, palaces, parks, zoos, lakes, beaches, markets, stadiums and similar) with articles in at "
                    f"least {MIN_SITELINKS} Wikipedia languages. The count of language editions stands in for how well known a "
                    "place is; it is not footfall.",
        source="pipeline/realestate/landmarks.py (Wikidata SPARQL, P31 attraction classes, sitelinks)",
        license="CC0 1.0 (Wikidata)", default_field="pull", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        items = query(r)
        rows = rows_for(items)
        print(f"{r}: {len(items)} landmarks in {len(rows)} blocks")
        if rows:
            cell_dataset(r, rows, len(items))
        time.sleep(2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
