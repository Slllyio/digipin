"""Traffic violations booked by police station, Mumbai 2024: Mumbai Traffic Police challan tables (via OpenCity, public domain).

Mumbai Traffic Police publish the violations they booked in 2024 (1 January to 31 December) by police station and by
offence: about 8.5 lakh in all, over half of them riding without a helmet. Each lived-in L7 block takes the figures of
the law-and-order police station whose jurisdiction holds it (``police_stations`` dataset, from policejuris.py);
station names in the challan table are matched to the jurisdiction map by spelling (``ALIAS`` for the ones that
differ). Dataset ``traffic_challans``:

    tc_total         violations booked in the station area, 2024
    tc_per_1000      per 1,000 residents of the station area
    tc_helmet_pct    share for riding without a helmet
    tc_signal_pct    share for jumping a signal
    tc_wrongway_pct  share for wrong-side driving or entering a one-way
    tc_obstruct_pct  share for causing obstruction to traffic (mostly parking)
    tc_drunk         drunk-driving cases booked

These count enforcement, not offending: a station that books more may simply patrol more.

    python -m pipeline.realestate.trafficchallans
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://data.opencity.in/dataset/2bd55423-6194-4dee-933b-b5d02c3e8d3d/resource/"
       "0a446b85-1883-4f42-842e-487866d56301/download/dd88da1c-1690-442e-aaac-7db837e14206.csv")
# challan-table spelling (normalised) -> jurisdiction-map spelling (normalised)
ALIAS = {"malwani": "malvani", "nmjoshi": "nmjoshimarg", "borivali": "boriwali", "kandivali": "kandiwali",
         "jogeshawari": "jogeshwari", "oshiwara": "oshivara", "vproad": "vpmarg", "dbmarg": "drdbmarg",
         "samatanagar": "samtanagar", "trombe": "trombay", "cuffpared": "cuffeparade", "jjmarg": "sirjjmarg",
         "varsova": "versova", "vileparle": "villeparle", "vinobabhavenagar": "vbnagar", "wadalatruckterminal": "wadalatt",
         "kalachowki": "kalachowky", "malbarhill": "malabarhill", "mhb": "mhbcolony", "azadmaidan": "aazadmaidan",
         "marindrive": "marinedrive"}
SHARES = {"tc_helmet_pct": ("Without Helmet",), "tc_signal_pct": ("Jumping signal",),
          "tc_wrongway_pct": ("Wrong side driving", "No Entry In Oneway"),
          "tc_obstruct_pct": ("Causing Obstruction To Free Flow Of Traffic",)}


def norm(name):
    s = re.sub(r"(?i)police station", "", name or "").lower()
    s = re.sub(r"[^a-z]", "", s)
    return ALIAS.get(s, s)


def _n(x):
    try:
        return int(float(str(x).replace(",", "").strip()))
    except ValueError:
        return 0


def stations(rows):
    """{normalised station: fields} from the station-wise violations table."""
    out = {}
    for r in rows:
        name = r.get("Traffic Police Station") or ""
        total = _n(r.get("Grand Total"))
        if not name or name.strip().lower() == "grand total" or total <= 0:
            continue
        f = {"tc_total": total, "tc_drunk": _n(r.get("Drunk and Drive"))}
        for key, cols in SHARES.items():
            f[key] = round(100 * sum(_n(r.get(c)) for c in cols) / total, 1)
        out[norm(name)] = f
    return out


def records(blocks, figs, pop):
    """blocks: {code: station name}; pop: {code: residents}. Adds tc_per_1000 from the station area's residents."""
    area_pop = {}
    for code, st in blocks.items():
        k = norm(st)
        area_pop[k] = area_pop.get(k, 0) + (pop.get(code) or 0)
    for code, st in blocks.items():
        k = norm(st)
        if k in figs:
            f = dict(figs[k])
            if area_pop.get(k):
                f["tc_per_1000"] = round(1000 * f["tc_total"] / area_pop[k], 1)
            yield {"digipin": code, **f}


def cell_dataset(region, recs, n):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pct = lambda key, label: FieldSpec(key, label, agg="max", unit="%", domain=[0, 100], ramp="reds", higher_is=None)
    specs = [
        FieldSpec("tc_total", "Traffic violations booked in the police station area, 2024", agg="max", unit="violations", ramp="reds", higher_is=None),
        FieldSpec("tc_per_1000", "Traffic violations booked per 1,000 residents of the station area, 2024", agg="max", unit="per 1,000", ramp="reds", higher_is=None),
        pct("tc_helmet_pct", "Share booked for riding without a helmet"),
        pct("tc_signal_pct", "Share booked for jumping a signal"),
        pct("tc_wrongway_pct", "Share booked for wrong-side driving or entering a one-way"),
        pct("tc_obstruct_pct", "Share booked for causing obstruction to traffic"),
        FieldSpec("tc_drunk", "Drunk-driving cases booked in the station area, 2024", agg="max", unit="cases", ramp="reds", higher_is=None),
    ]
    spec = DatasetSpec(
        id="traffic_challans", title="Traffic violations booked by police station (Mumbai Traffic Police, 2024)", level=LEVEL,
        fields=specs, group="Mobility",
        description=f"Violations Mumbai Traffic Police booked in 2024 in each of {n} police station areas, by offence (via "
                    "data.opencity.in); every block carries its station's figures. Counts enforcement, not offending.",
        source="pipeline/realestate/trafficchallans.py (Mumbai Traffic Police violations 2024 via OpenCity; station areas from policejuris.py)",
        license="Public domain (Mumbai Traffic Police via data.opencity.in)", default_field="tc_per_1000", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def _region_table(dataset, region):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    d = next(x for x in cat["datasets"] if x["id"] == dataset)
    return store.read_region(CELLS, next(r for r in d["regions"] if r["name"] == region))


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="mumbai")
    region = ap.parse_args(argv).region
    figs = stations(csv.DictReader(io.StringIO(requests.get(URL, timeout=120).content.decode("utf-8-sig"))))
    ps = _region_table("police_stations", region)
    blocks = {c: s for c, s in zip(ps.codes, ps.columns["station"]) if s}
    pt = _region_table("population", region)
    pop = dict(zip(pt.codes, pt.columns["population"]))
    recs = list(records(blocks, figs, pop))
    matched = {norm(s) for s in blocks.values()} & set(figs)
    info = cell_dataset(region, recs, len(matched))
    print(f"{region}: {len(figs)} stations in the table, {len(matched)} matched to the map; {info['cells']} blocks; "
          f"{sum(f['tc_total'] for k, f in figs.items() if k in matched):,} of {sum(f['tc_total'] for f in figs.values()):,} violations placed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
