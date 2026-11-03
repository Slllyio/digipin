"""What a month's kitchen basket costs in the city: WFP's copy of India's retail food price series (via HDX, CC BY-IGO).

The World Food Programme republishes the Department of Consumer Affairs' price monitoring: monthly retail prices of
staples in about 160 centres from 1994 to mid-2023. Eleven DigiPin cities are price centres (Pune and Guna are not).
A fixed household basket (``BASKET``, a month for a family of four or five: rice, wheat flour, lentils, oil, sugar, milk,
potatoes, onions, tomatoes, tea and salt) is priced each month where every item has a price. Per city (dataset
``food_prices``, one value per city copied to every lived-in L7 block):

    fp_basket_rs      basket cost, mean of the last 12 priced months (₹)
    fp_vs_median_pct  that cost against the median of the eleven cities (%)
    fp_10y_pct        change against the same 12 calendar months ten years earlier, over the items priced then (%)
    fp_onion_swing    highest over lowest monthly onion price in the last five years (×)
    fp_last_year      year of the last priced month

    python -m pipeline.realestate.foodprices
"""
from __future__ import annotations

import argparse
import csv
import io
import statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.humdata.org/dataset/dc663585-4b6f-46ae-a6d6-b2f3e4ea32b5/resource/"
       "3b1ff071-6b01-4998-aa62-2f3efb5d4888/download/wfp_food_prices_ind.csv")
BASKET = {"Rice": 10, "Wheat flour": 10, "Lentils": 3, "Oil (mustard)": 2, "Sugar": 2, "Milk (pasteurized)": 30,
          "Potatoes": 5, "Onions": 4, "Tomatoes": 3, "Tea (black)": 0.25, "Salt (iodised)": 1}
MARKET = {"ahmedabad": "Ahmedabad", "bengaluru": "Bengaluru", "bhopal": "Bhopal", "chennai": "Chennai", "delhi": "Delhi",
          "hyderabad": "Hyderabad", "indore_pilot": "Indore", "jaipur": "Jaipur", "kolkata": "Kolkata", "lucknow": "Lucknow",
          "mumbai": "Mumbai"}


def monthly(rows, market):
    """{(year, month): {commodity: retail price}} for one market (mean of the month's quotes)."""
    acc = {}
    for r in rows:
        if r.get("market") != market or r.get("pricetype") != "Retail" or r.get("commodity") not in BASKET:
            continue
        try:
            y, m = int(r["date"][:4]), int(r["date"][5:7])
            p = float(r["price"])
        except (ValueError, KeyError):
            continue
        acc.setdefault((y, m), {}).setdefault(r["commodity"], []).append(p)
    return {k: {c: sum(v) / len(v) for c, v in d.items()} for k, d in acc.items()}


def basket(month):
    if not all(c in month for c in BASKET):
        return None
    return sum(month[c] * q for c, q in BASKET.items())


def figures(months):
    priced = sorted(k for k in months if basket(months[k]) is not None)
    if len(priced) < 6:
        return {}
    last = priced[-12:]
    cost = sum(basket(months[k]) for k in last) / len(last)
    f = {"fp_basket_rs": round(cost), "fp_last_year": last[-1][0]}
    then = [(y - 10, m) for y, m in last if (y - 10, m) in months]
    now_w = then_w = 0.0
    for c, q in BASKET.items():                      # items priced in both windows, weighted by today's basket
        a = [months[k][c] for k in last if c in months[k]]
        b = [months[k][c] for k in then if c in months[k]]
        if len(a) >= 6 and len(b) >= 6:
            now_w += q * sum(a) / len(a)
            then_w += q * sum(b) / len(b)
    if then_w and now_w >= 0.6 * cost:
        f["fp_10y_pct"] = round(100 * (now_w / then_w - 1))
    y0 = last[-1][0] - 5
    onions = [months[k]["Onions"] for k in sorted(months) if k[0] > y0 and "Onions" in months[k]]
    if len(onions) >= 24 and min(onions) > 0:
        f["fp_onion_swing"] = round(max(onions) / min(onions), 1)
    return f


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, better="worse": FieldSpec(k, label, agg="max", unit=unit, ramp="reds", higher_is=better)
    specs = [
        v("fp_basket_rs", "A month's kitchen basket at retail prices (last 12 priced months)", "₹"),
        v("fp_vs_median_pct", "Basket cost against the median of the eleven price-centre cities", "%"),
        v("fp_10y_pct", "Basket cost change over ten years", "%"),
        v("fp_onion_swing", "Dearest over cheapest monthly onion price, last five years", "×"),
        v("fp_last_year", "Year of the last priced month", "year", None),
    ]
    spec = DatasetSpec(
        id="food_prices", title="Kitchen basket cost (retail food prices, WFP / Department of Consumer Affairs)", level=LEVEL,
        fields=specs, group="Real estate",
        description="A fixed month's basket of eleven staples priced at the city's retail prices (Department of Consumer Affairs "
                    "price monitoring, republished by the World Food Programme via HDX), 1994 to mid-2023. One value per city.",
        source="pipeline/realestate/foodprices.py (WFP food prices for India via HDX)",
        license="CC BY-IGO (World Food Programme, data from the Department of Consumer Affairs, Government of India)",
        default_field="fp_basket_rs", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--csv", help="local copy of wfp_food_prices_ind.csv")
    a = ap.parse_args(argv)
    text = open(a.csv, encoding="utf-8-sig").read() if a.csv else requests.get(URL, timeout=300).content.decode("utf-8-sig")
    rows = [r for r in csv.DictReader(io.StringIO(text)) if not r["date"].startswith("#")]
    figs = {region: figures(monthly(rows, m)) for region, m in MARKET.items()}
    figs = {k: v for k, v in figs.items() if v}
    med = statistics.median(f["fp_basket_rs"] for f in figs.values())
    for region, f in figs.items():
        f["fp_vs_median_pct"] = round(100 * (f["fp_basket_rs"] / med - 1))
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
