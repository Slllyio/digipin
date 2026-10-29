"""What urban households spend: HCES 2023-24 household data for seven cities (MoSPI via OpenCity, public domain).

The Household Consumption Expenditure Survey 2023-24 unit-level files on OpenCity are cut to the districts of seven
cities. Two files are read, for urban households (sector 2): level 14 (each household's value per item group from the
summary blocks A1, B1 and C1 of the food, consumables-and-services and durables questionnaires) and level 15 (household
size and survey weight). The files with religion, social group and occupation are never opened.

Item groups come at their questionnaire's reference period: 7 days for milk, vegetables, fruit, egg-fish-meat, oil,
spices, beverages, processed food, pan, tobacco and intoxicants; 365 days for education, hospitalisation, clothing,
footwear, bedding and durable goods; 30 days for the rest. Each is turned to 30 days, and imputed rent (539) is left
out, as MoSPI does for MPCE without imputation. Checked against MoSPI: Delhi urban comes to ₹8,542 a month.

Per city (dataset ``hces``, one value per city at L5):

    hc_mpce            monthly consumption per person, ₹ (weighted total over weighted people)
    hc_mpce_median     the middle person's household MPCE, ₹
    hc_<group>_pct     share of consumption: food, rent, transport (conveyance), education, medical, fuel (fuel and
                       light), goods (clothing, footwear, bedding and durables)
    hc_renters_pct     households paying rent
    hc_rent            average monthly rent paid by those households, ₹
    hc_top_bottom      average MPCE of the richest fifth of people over the poorest fifth
    hc_gini            Gini index of MPCE across people
    hc_households      urban households surveyed

    python -m pipeline.realestate.hces --region all
"""
from __future__ import annotations

import argparse
import csv
import io
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 5
DS = "https://data.opencity.in/dataset/d3a6bc19-1a9d-4a72-9b33-990537931a40/resource/"
ZIPS = {
    "bengaluru": DS + "aef9093d-5270-4852-8175-d53629dcfd64/download/bengaluru_hces_levels_data.zip",
    "chennai": DS + "749de836-dcee-4a45-9641-c44b540c5621/download/chennai_hces_levels_data.zip",
    "delhi": DS + "29b55ef3-7723-4ce3-ba62-cf8d14fb9347/download/delhi_hces_levels_data.zip",
    "hyderabad": DS + "db5dbe02-f881-45d1-97ce-84018693bfb6/download/hyderabad_rangareddy_hces_levels_data.zip",
    "kolkata": DS + "a1f65a32-0637-498b-b736-e561c6a503f2/download/kolkata_hces_levels_data.zip",
    "mumbai": DS + "092e5b42-ce5a-49ce-ba20-fba033644b7d/download/mumbai_hces_levels_data.zip",
    "pune": DS + "d22df550-327c-40f5-96e9-5c8fd7be2b48/download/pune_hces_levels_data.zip",
}
KEY = ("FSU_Serial_No", "Sample_Sub_Division_No", "Second_Stage_Stratum_No", "Sample_Household_No")
DAYS7 = {"169", "219", "239", "249", "199", "189", "269", "279", "289", "299", "309", "319", "329"}
DAYS365 = {"409", "419", "379", "389", "399", "559", "569", "579", "599", "609", "619", "629", "639", "649", "099"}
IMPUTED_RENT = "539"
GROUPS = {"rent": {"529"}, "transport": {"519"}, "education": {"409"}, "medical": {"419", "429"}, "fuel": {"349"}}


def households(level14, level15, sector="2"):
    """[(weight, size, {item code: ₹ a month})] for households of ``sector`` that answered all three questionnaires."""
    info = {}
    for r in level15:
        k = tuple(r.get(x) for x in KEY)
        try:
            size = float(r.get("HOUSEHOLD_SIZE") or 0)
            h = info.setdefault(k, {"w": float(r["MULTIPLIER"]), "size": 0.0, "sector": r.get("Sector")})
        except (TypeError, ValueError):
            continue
        h["size"] = max(h["size"], size)
    items, qs = {}, {}
    for r in level14:
        k, code = tuple(r.get(x) for x in KEY), str(r.get("ITEM_CODE") or "").strip()
        if code == IMPUTED_RENT or k not in info or info[k]["sector"] != sector:
            continue
        try:
            v = float(r.get("VALUE_RS") or 0)
        except ValueError:
            continue
        v *= 30 / 7 if code in DAYS7 else 30 / 365 if code in DAYS365 else 1
        d = items.setdefault(k, {})
        d[code] = d.get(code, 0) + v
        qs.setdefault(k, set()).add(r.get("Questionnaire_No"))
    return [(info[k]["w"], info[k]["size"], d) for k, d in items.items() if qs[k] >= {"F", "C", "D"} and info[k]["size"] > 0]


def summary(hh):
    """{field: value} for one city's households."""
    if len(hh) < 50:
        return None
    food = lambda d: sum(v for c, v in d.items() if int(c) < 300 and c != "099")
    goods = lambda d: sum(v for c, v in d.items() if c in DAYS365 and c not in ("409", "419"))
    people = sum(w * s for w, s, _ in hh)
    allx = sum(w * sum(d.values()) for w, _, d in hh)
    share = lambda f: round(100 * sum(w * f(d) for w, _, d in hh) / allx, 1)
    out = {"hc_mpce": round(allx / people), "hc_food_pct": share(food), "hc_goods_pct": share(goods)}
    for g, codes in GROUPS.items():
        out[f"hc_{g}_pct"] = share(lambda d, codes=codes: sum(d.get(c, 0) for c in codes))
    renters = [(w, d["529"]) for w, _, d in hh if d.get("529", 0) > 0]
    W = sum(w for w, _, _ in hh)
    out["hc_renters_pct"] = round(100 * sum(w for w, _ in renters) / W, 1)
    out["hc_rent"] = round(sum(w * r for w, r in renters) / sum(w for w, _ in renters)) if renters else None
    # people ranked by their household's MPCE
    ppl = sorted(((sum(d.values()) / s, w * s) for w, s, d in hh), key=lambda t: t[0])
    P = sum(p for _, p in ppl)
    acc, med = 0.0, None
    for m, p in ppl:
        acc += p
        if med is None and acc >= P / 2:
            med = m

    def band(lo, hi):
        s = n = cum = 0.0
        for m, p in ppl:
            a, b = max(cum, lo * P), min(cum + p, hi * P)
            if b > a:
                s += m * (b - a)
                n += b - a
            cum += p
        return s / n if n else None
    cum = area = 0.0
    for m, p in ppl:      # Gini from the Lorenz curve
        area += p * (2 * cum + m * p)
        cum += m * p
    bottom, top = band(0, 0.2), band(0.8, 1)
    out.update(hc_mpce_median=round(med), hc_top_bottom=round(top / bottom, 1) if bottom else None,
               hc_gini=round(1 - area / (P * cum), 3) if cum else None, hc_households=len(hh))
    return out


def read_zip(blob):
    """(level 14 rows, level 15 rows) from a city's zip."""
    z = zipfile.ZipFile(io.BytesIO(blob))
    pick = lambda lv: next(n for n in z.namelist() if f"LEVEL - {lv}" in n.upper())
    return tuple(csv.DictReader(io.StringIO(z.read(pick(lv)).decode("utf-8-sig"))) for lv in (14, 15))


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    specs = [
        FieldSpec("hc_mpce", "Monthly consumption per person, urban households (2023-24)", agg="mean", unit="₹", ramp="viridis", higher_is=None),
        FieldSpec("hc_mpce_median", "Middle person's monthly consumption, urban (2023-24)", agg="mean", unit="₹", ramp="viridis", higher_is=None),
        FieldSpec("hc_food_pct", "Food's share of urban household consumption", agg="mean", unit="%", domain=[20, 60], ramp="viridis", higher_is=None),
        FieldSpec("hc_rent_pct", "Rent's share of urban household consumption", agg="mean", unit="%", domain=[0, 30], ramp="viridis", higher_is=None),
        FieldSpec("hc_transport_pct", "Transport's share of consumption", agg="mean", unit="%", domain=[0, 20], ramp="viridis", higher_is=None),
        FieldSpec("hc_education_pct", "Education's share of consumption", agg="mean", unit="%", domain=[0, 20], ramp="viridis", higher_is=None),
        FieldSpec("hc_medical_pct", "Medical care's share of consumption", agg="mean", unit="%", domain=[0, 20], ramp="viridis", higher_is=None),
        FieldSpec("hc_fuel_pct", "Fuel and light's share of consumption", agg="mean", unit="%", domain=[0, 20], ramp="viridis", higher_is=None),
        FieldSpec("hc_goods_pct", "Clothing, footwear, bedding and durables' share of consumption", agg="mean", unit="%", domain=[0, 40], ramp="viridis", higher_is=None),
        FieldSpec("hc_renters_pct", "Urban households paying rent", agg="mean", unit="%", domain=[0, 80], ramp="viridis", higher_is=None),
        FieldSpec("hc_rent", "Average monthly rent paid by renting households (2023-24)", agg="mean", unit="₹", ramp="viridis", higher_is=None),
        FieldSpec("hc_top_bottom", "Richest fifth's consumption over the poorest fifth's", agg="mean", unit="times", ramp="reds", higher_is="worse"),
        FieldSpec("hc_gini", "Gini index of consumption per person", agg="mean", unit="index", domain=[0.2, 0.5], ramp="reds", higher_is="worse"),
        FieldSpec("hc_households", "Urban households surveyed", agg="max", unit="households", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="hces", title="Household spending (HCES 2023-24)", level=LEVEL, fields=specs, group="Real estate",
        description="Monthly consumption per person, how it splits between food, rent, transport, education, medical care, fuel "
                    "and goods, the share of households renting and the rent they pay, for urban households in the city's districts, from MoSPI's Household Consumption Expenditure Survey "
                    "2023-24 household files (via data.opencity.in). One value per city; free items from welfare schemes are not "
                    "imputed. The survey's religion, caste and occupation fields are not read.",
        source="pipeline/realestate/hces.py (HCES 2023-24 unit-level item-group summaries, urban sector, survey weights)",
        license="Public domain (MoSPI via data.opencity.in)", default_field="hc_mpce", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    rows = ({"digipin": c, **{k: v for k, v in fig.items() if v is not None}} for c in codes)
    return store.write_dataset(CELLS, spec, region, store.bin_records(rows, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for region in (list(ZIPS) if a.region == "all" else a.region.split(",")):
        r = requests.get(ZIPS[region], timeout=300)
        r.raise_for_status()
        fig = summary(households(*read_zip(r.content)))
        if not fig:
            print(f"{region}: too few urban households")
            continue
        info = cell_dataset(region, fig)
        print(f"{region}: {fig}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
