"""State health now: NFHS-6 (2023-24) state fact sheets against NFHS-5 (2019-21), per city (OpenCity, public domain).

NFHS-6 district fact sheets are not out yet; the state fact sheets are, with the urban, rural and total values for
2023-24 and the state's NFHS-5 total. Each city's L5 blocks carry its state's figures (dataset ``nfhs6``), so lenses
can set the city's NFHS-5 district values (``nfhs`` dataset) against the newest round:

    n6u_<f>   the state's towns and cities, 2023-24 (%)
    n6_<f>    the whole state, 2023-24 (%)
    n5_<f>    the whole state, 2019-21 (%)

for f in FIELDS: children stunted and wasted, women and men overweight or obese, raised blood sugar and blood pressure
(women and men), and households with health insurance. Delhi, Uttar Pradesh, Rajasthan and Madhya Pradesh fact
sheets are not on OpenCity yet, so their cities are skipped.

    python -m pipeline.realestate.nfhs6 --region all
"""
from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 5
PACKAGE = "nfhs-6-2023-24"
STATE = {"bengaluru": "Karnataka", "mumbai": "Maharashtra", "pune": "Maharashtra", "chennai": "Tamil Nadu", "hyderabad": "Telangana",
         "kolkata": "West Bengal", "ahmedabad": "Gujarat"}
# field -> (indicator text prefix, label)
FIELDS = {
    "stunted": ("Children under 5 years who are stunted", "children under 5 stunted"),
    "wasted": ("Children under 5 years who are wasted", "children under 5 wasted"),
    "women_obese": ("Women who are overweight or obese", "women overweight or obese"),
    "men_obese": ("Men who are overweight or obese", "men overweight or obese"),
    "sugar_women": ("Women - Blood sugar level high or very high", "women with raised blood sugar"),
    "sugar_men": ("Men - Blood sugar level high or very high", "men with raised blood sugar"),
    "bp_women": ("Women - Elevated blood pressure", "women with raised blood pressure"),
    "bp_men": ("Men - Elevated blood pressure", "men with raised blood pressure"),
    "insurance": ("Households with any usual member covered under a health insurance", "households with health insurance"),
}


def _num(s):
    try:
        return float(str(s).replace("*", "").strip("() "))
    except (TypeError, ValueError):
        return None


def state_figures(rows):
    """{field: value} from a state fact-sheet CSV (Indicator, NFHS6_Urban, NFHS6_Total, NFHS5_Total)."""
    out = {}
    for r in rows:
        ind = (r.get("Indicator") or "").strip()
        for f, (pre, _) in FIELDS.items():
            if ind.startswith(pre) and f"n6_{f}" not in out:
                for k, col in (("n6u", "NFHS6_Urban"), ("n6", "NFHS6_Total"), ("n5", "NFHS5_Total")):
                    v = _num(r.get(col))
                    if v is not None:
                        out[f"{k}_{f}"] = v
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    specs = []
    for f, (_, label) in FIELDS.items():
        hi = "better" if f == "insurance" else "worse"
        specs += [FieldSpec(f"n6u_{f}", f"State towns and cities, 2023-24: {label}", agg="mean", unit="%", domain=[0, 60], ramp="viridis", higher_is=hi),
                  FieldSpec(f"n6_{f}", f"State, 2023-24: {label}", agg="mean", unit="%", domain=[0, 60], ramp="viridis", higher_is=hi),
                  FieldSpec(f"n5_{f}", f"State, 2019-21: {label}", agg="mean", unit="%", domain=[0, 60], ramp="viridis", higher_is=hi)]
    spec = DatasetSpec(
        id="nfhs6", title="State health now (NFHS-6 2023-24)", level=LEVEL, fields=specs, group="Health",
        description="National Family Health Survey 2023-24 (NFHS-6) state fact sheets via data.opencity.in: the state's towns and "
                    "cities and the whole state in 2023-24, and the whole state in 2019-21 (NFHS-5), for child stunting and wasting, "
                    "overweight, raised blood sugar and blood pressure, and health insurance. One value per state; district "
                    "fact sheets are not out yet.",
        source="pipeline/realestate/nfhs6.py (OpenCity NFHS-6 state fact sheets)",
        license="Public domain (IIPS / MoHFW via data.opencity.in)", default_field="n6u_sugar_women", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    regions = list(STATE) if a.region == "all" else a.region.split(",")
    res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PACKAGE}, timeout=60).json()["result"]["resources"]
    for region in regions:
        state = STATE.get(region)
        url = next((r["url"] for r in res if r["format"] == "CSV" and state and r["name"].startswith(state)), None)
        if not url:
            print(f"{region}: no NFHS-6 state fact sheet")
            continue
        fig = state_figures(csv.DictReader(io.StringIO(requests.get(url, timeout=120).content.decode("utf-8-sig"))))
        info = cell_dataset(region, fig)
        print(f"{region}: {state}, {len(fig)} values, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
