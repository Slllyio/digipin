"""UN SDG 11 city scorecard: public open space and public transport access, from NASA SEDAC's SDG Indicators 2023 release
(CIESIN; CC BY 4.0, commercial use allowed).

Both tables cover the JRC GHS Urban Centre Database cities:

* SDG 11.7.1, Urban Public Space, Availability and Access: the share of the urban centre's area that is OpenStreetMap
  open public space (parks, squares, playgrounds and the like) and the share of WorldPop residents within 400 m of one.
* SDG 11.2.1, Urban Access to Public Transport: the share of WorldPop residents within walking distance of an
  OpenStreetMap public transport stop (500 m for low-capacity stops such as buses, 1 km for rail and BRT).

OSM coverage drives both, so a low score can mean unmapped parks or stops as well as missing ones. Per city (dataset
``sdg_city``, one value per city copied to every lived-in L7 block):

    sdg_space_pct         open public space, % of the urban centre's area (11.7.1)
    sdg_space_access_pct  residents within 400 m of open public space, % (11.7.1)
    sdg_transit_pct       residents with convenient access to public transport, % (11.2.1)
    sdg_*_india_pctile    share of India's urban centres of a million or more scoring lower (%)
    sdg_*_world_pctile    the same among the world's urban centres of a million or more (%)

Download the two CSV zips with Earthdata access:
https://data.earthdata.nasa.gov/nasa-earth/human-dimensions/sedac-root/downloads/data/sdgi/sdgi-11-7-1-urban-public-space-availability-access-2023/sdgi-11-7-1-urban-public-space-availability-access-2023-csv.zip
https://data.earthdata.nasa.gov/nasa-earth/human-dimensions/sedac-root/downloads/data/sdgi/sdgi-11-2-1-urban-access-public-transport-2023/sdgi-11-2-1-urban-access-public-transport-2023-csv.zip

    python -m pipeline.realestate.sdgcity --space /path/...11-7-1...-table.csv --transit /path/...11-2-1...-table.csv
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from pipeline.realestate.landefficiency import BIG, below_share

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NAME = {"ahmedabad": "Ahmedabad", "bengaluru": "Bengaluru", "bhopal": "Bhopal", "chennai": "Chennai",
        "delhi": "Delhi [New Delhi]", "guna": "Guna", "hyderabad": "Hyderabad", "indore_pilot": "Indore", "jaipur": "Jaipur",
        "kolkata": "Kolkata", "lucknow": "Lucknow", "mumbai": "Mumbai", "pune": "Pune"}
SCORES = ("space", "space_access", "transit")


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v < 0 else v  # -9999 is no data


def read_tables(space_csv, transit_csv):
    """-> [{oid, iso, name, pop, space, space_access, transit}] joined on OID_ (the two tables share the UCDB row order)."""
    def rows(p):
        with open(p, encoding="utf-8-sig", newline="") as f:
            return {r["OID_"]: r for r in csv.DictReader(f)}
    a, b = rows(space_csv), rows(transit_csv)
    out = []
    for oid, r in a.items():
        t = b.get(oid, {})
        out.append({"oid": oid, "iso": r["CTR_MN_ISO"], "name": r["UC_NM_MN"], "pop": _num(r["Total_POP"]) or 0,
                    "space": _num(r["SDG1171pct"]), "space_access": _num(r["Pct_Access"]), "transit": _num(t.get("SDG1121pct"))})
    return out


def city_rows(centres):
    """centres from read_tables -> {region: fields}. Several centres can share a name; the most populous wins."""
    big = [c for c in centres if c["pop"] >= BIG]
    by = {}
    for c in centres:
        if c["iso"] == "IND" and (c["name"] not in by or c["pop"] > by[c["name"]]["pop"]):
            by[c["name"]] = c
    out = {}
    for region, name in NAME.items():
        c = by.get(name)
        if not c:
            continue
        f = {}
        for k in SCORES:
            if c[k] is None:
                continue
            f[f"sdg_{k}_pct"] = round(c[k], 1)
            f[f"sdg_{k}_india_pctile"] = below_share(c[k], [o[k] for o in big if o["iso"] == "IND"])
            f[f"sdg_{k}_world_pctile"] = below_share(c[k], [o[k] for o in big])
        if f:
            out[region] = f
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    label = {"space": "Open public space, share of urban area", "space_access": "Residents within 400 m of open public space",
             "transit": "Residents with convenient public transport access"}
    specs = []
    for k in SCORES:
        specs.append(FieldSpec(f"sdg_{k}_pct", f"{label[k]} (SDG 11)", agg="max", unit="%", domain=[0, 100], ramp="greens", higher_is="better"))
        specs.append(FieldSpec(f"sdg_{k}_india_pctile", f"{label[k]}: Indian 1M+ cities scoring lower", agg="max", unit="%", domain=[0, 100], ramp="greens", higher_is="better"))
        specs.append(FieldSpec(f"sdg_{k}_world_pctile", f"{label[k]}: world 1M+ cities scoring lower", agg="max", unit="%", domain=[0, 100], ramp="greens", higher_is="better"))
    spec = DatasetSpec(
        id="sdg_city", title="UN SDG 11 scorecard: public space and transit (NASA SEDAC 2023)", level=LEVEL, fields=specs,
        group="Real estate",
        description="SDG 11.7.1 (OpenStreetMap open public space as a share of the GHSL urban centre, and residents within 400 m "
                    "of one) and SDG 11.2.1 (residents within 500 m of a bus stop or 1 km of rail/BRT), WorldPop residents, "
                    "from NASA SEDAC's SDG Indicators 2023 release. One value per city.",
        source="pipeline/realestate/sdgcity.py (NASA SEDAC sdgi-11-7-1 and sdgi-11-2-1 2023 CSV tables)",
        license="CC BY 4.0 (CIESIN 2023, NASA SEDAC, doi:10.7927/eavc-4k45 and doi:10.7927/1a5z-3h71); OSM data ODbL",
        default_field="sdg_space_access_pct", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--space", required=True, help="sdgi-11-7-1-urban-public-space-availability-access-2023-table.csv")
    ap.add_argument("--transit", required=True, help="sdgi-11-2-1-urban-access-public-transport-2023-table.csv")
    a = ap.parse_args(argv)
    for region, f in city_rows(read_tables(a.space, a.transit)).items():
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
