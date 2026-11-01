"""Premium and everyday chain outlets per block from Overture Maps places brands (CDLA-Permissive-2.0; brand
names only).

Where premium chains open (a Starbucks, an Apple reseller, a Zara, a Nexa or BMW showroom) tells you where retailers expect
spending power, and it is an open signal of affluence that needs no household survey. Everyday chains (Domino's, Reliance
Fresh, public-sector banks) are counted alongside for contrast. Places with confidence >= 0.6 and not closed are matched on
brand name (dataset ``premium_brands``, L7 blocks):

    pb_premium     premium chain outlets (see PREMIUM)
    pb_everyday    everyday chain outlets (see EVERYDAY)
    pb_premium_share  premium / (premium + everyday), %, where at least 3 chain outlets are matched

Brand coverage in Overture is uneven (big chains are mapped best), so this is a signal, not a census.

    env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY python -m pipeline.realestate.premiumbrands --region delhi
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import bbox_for
from pipeline.realestate.places import MIN_CONF, RELEASE

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
PREMIUM = re.compile(r"\b(starbucks|costa coffee|third wave|blue tokai|theobroma|tim hortons|apple|imagine|unicorn|zara|h ?& ?m|"
                     r"marks (and|&) spencer|uniqlo|mango|forever new|levi'?s|tommy hilfiger|calvin klein|benetton|"
                     r"adidas|nike|puma|skechers|decathlon|mac cosmetics|sephora|nykaa luxe|forest essentials|kama ayurveda|"
                     r"tanishq|caratlane|kalyan jewellers|malabar gold|bluestone|shoppers stop|westside|"
                     r"nexa|bmw|mercedes|audi|jaguar|land rover|volvo|lexus|porsche|skoda|volkswagen|jeep|"
                     r"pvr|inox|cinepolis|smaaash|gold'?s gym|cult\.?fit|anytime fitness|the beer cafe|social offline|"
                     r"barbeque nation|hard rock|taj (hotels?|palace)|vivanta|marriott|hyatt|radisson|itc hotel|oberoi|leela|hilton|lemon tree)\b", re.I)
EVERYDAY = re.compile(r"\b(domino'?s|pizza hut|subway|mcdonald'?s|kfc|burger king|haldiram'?s|monginis|chaayos|"
                      r"reliance (fresh|smart|digital)|smart bazaar|more (supermarket|retail)|d-?mart|vishal mega mart|easyday|"
                      r"big bazaar|spencer'?s|bata|relaxo|vijay sales|croma|lenskart|"
                      r"state bank|sbi|punjab national bank|bank of baroda|canara bank|union bank|central bank|uco bank|bank of india|"
                      r"indian bank|indian oil|hindustan petroleum|bharat petroleum|oyo|apollo pharmacy|medplus|"
                      r"maruti suzuki arena|hero|bajaj|tvs)\b", re.I)


def kind_of(brand):
    """Brand name -> 'premium', 'everyday' or None (premium wins, so 'Reliance Trends' style clashes are rare)."""
    if not brand:
        return None
    if PREMIUM.search(brand):
        return "premium"
    if EVERYDAY.search(brand):
        return "everyday"
    return None


def rows_from(points):
    """points [(lat, lng, brand)] -> {L7 code: fields}."""
    acc = {}
    for lat, lng, brand in points:
        k = kind_of(brand)
        if not k:
            continue
        code = digipin.encode(lat, lng).replace("-", "")[:LEVEL]
        a = acc.setdefault(code, {"pb_premium": 0, "pb_everyday": 0})
        a["pb_" + k] += 1
    for a in acc.values():
        t = a["pb_premium"] + a["pb_everyday"]
        if t >= 3:
            a["pb_premium_share"] = round(100 * a["pb_premium"] / t, 1)
    return acc


def fetch(region, release=RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    raw = con.execute(f"""
        SELECT (bbox.ymin + bbox.ymax) / 2, (bbox.xmin + bbox.xmax) / 2, brand.names.primary
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n} AND brand IS NOT NULL
          AND confidence >= {MIN_CONF} AND coalesce(operating_status, 'open') <> 'permanently_closed'
    """).fetchall()
    return rows_from(raw)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("pb_premium", "Premium chain outlets (cafés, fashion, jewellery, luxury cars, cinemas, hotels)", agg="sum", unit="outlets", ramp="viridis"),
        FieldSpec("pb_everyday", "Everyday chain outlets (fast food, supermarkets, public-sector banks, fuel)", agg="sum", unit="outlets", ramp="viridis"),
        FieldSpec("pb_premium_share", "Premium share of chain outlets", agg="mean", unit="%", domain=[0, 100], ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="premium_brands", title="Premium and everyday chain outlets (Overture places brands)", level=LEVEL, fields=specs,
        group="Real estate",
        description=f"Overture Maps places (release {RELEASE}, confidence >= {MIN_CONF}, not closed) matched on brand name to a list "
                    "of premium and everyday chains. Big chains are mapped best; a signal of where retailers expect spending power.",
        source="pipeline/realestate/premiumbrands.py (Overture Maps places via DuckDB)",
        license="CDLA-Permissive-2.0 (Overture Maps places)", default_field="pb_premium", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        rows = fetch(region)
        if not rows:
            print(f"{region}: none")
            continue
        info = cell_dataset(region, rows)
        v = rows.values()
        print(f"{region}: premium {sum(r['pb_premium'] for r in v)}, everyday {sum(r['pb_everyday'] for r in v)}; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
