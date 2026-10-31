"""Which city's climate will mine have in the 2030s: climate analogues from the GHSL Urban Centre Database 2025 climate theme
(European Commission JRC, GHS-UCDB R2024A V1.2, CC BY 4.0; bioclimatic indicators from the Copernicus Climate Change
Service, Wouters 2021, doi:10.24381/cds.bce175f0, Copernicus licence: free use with attribution).

The UCDB gives every urban centre decade averages of four bioclimatic indicators from reanalysis (1970s-2010s) and from
an ensemble of CMIP5 models under RCP 4.5 and RCP 8.5 (2020s, 2030s), averaged over the coarse (about 0.5 degree) grid
cells touching the centre:

    B01  annual mean temperature (°C)       B04  temperature seasonality (100 x standard deviation of monthly means)
    B12  annual rainfall (mm)               B15  rainfall seasonality (coefficient of variation of monthly totals)

A climate analogue (Fitzpatrick and Dunn 2019; Bastin et al. 2019) is the city whose climate today (2010s) is closest to
what the model ensemble projects for this city in the 2030s under RCP 8.5. Closeness is the Euclidean distance over the
four indicators, each divided by its spread across the world's urban centres of a million or more (the candidates). Per
city (dataset ``climate_twin``, one value per city copied to every lived-in L7 block):

    ct_temp_1970 / ct_temp_2010    annual mean temperature, 1970s and 2010s (°C)
    ct_temp_2030                   projected for the 2030s, RCP 8.5 (°C)
    ct_temp_2030_45                projected for the 2030s, RCP 4.5 (°C)
    ct_rain_2010 / ct_rain_2030    annual rainfall, 2010s and 2030s RCP 8.5 (mm)
    ct_twin_id / ct_twin_dist      UCDB id of the closest analogue anywhere, and its distance (standardised units)
    ct_abroad_id / ct_abroad_dist  the closest analogue outside India

The analogue ids are decoded to names in the lens (``TWIN_NAMES`` printed by this script).

    python -m pipeline.realestate.climatetwin --gpkg GHS_UCDB_GLOBE_R2024A.gpkg
"""
from __future__ import annotations

import argparse
import math
import statistics
from pathlib import Path

from pipeline.realestate.landefficiency import BIG, CITY, num

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LAYER = "GHSL_UCDB_THEME_CLIMATE_GLOBE_R2024A"
VARS = ("B01", "B12", "B04", "B15")


def distance(a, b, spread):
    return math.sqrt(sum(((x - y) / s) ** 2 for x, y, s in zip(a, b, spread)))


def analogues(target, candidates, spread, exclude=(), country=None):
    """Closest candidate (id, dist) to ``target`` among [{id, country, now}] not in ``exclude``, optionally not in ``country``."""
    best = None
    for c in candidates:
        if c["id"] in exclude or (country and c["country"] == country):
            continue
        dd = distance(target, c["now"], spread)
        if best is None or dd < best[1]:
            best = (c["id"], dd)
    return best


def city_rows(centres):
    """centres: [{id, name, country, pop, now: [4], fut85: [4], fut45: [4], t1970}] -> ({region: fields}, {id: name})."""
    cand = [c for c in centres if (c["pop"] or 0) >= BIG and None not in c["now"]]
    spread = [statistics.pstdev(c["now"][k] for c in cand) for k in range(len(VARS))]
    by = {c["name"]: c for c in centres if c["country"] == "India"}
    out, names = {}, {}
    for region, name in CITY.items():
        c = by.get(name)
        if not c or None in c["now"] or None in c["fut85"]:
            continue
        f = {"ct_temp_2010": round(c["now"][0], 1), "ct_temp_2030": round(c["fut85"][0], 1),
             "ct_rain_2010": round(c["now"][1]), "ct_rain_2030": round(c["fut85"][1])}
        if c.get("t1970") is not None:
            f["ct_temp_1970"] = round(c["t1970"], 1)
        if c["fut45"][0] is not None:
            f["ct_temp_2030_45"] = round(c["fut45"][0], 1)
        for key, kw in (("twin", {}), ("abroad", {"country": "India"})):
            hit = analogues(c["fut85"], cand, spread, exclude={c["id"]}, **kw)
            if hit:
                f[f"ct_{key}_id"], f[f"ct_{key}_dist"] = hit[0], round(hit[1], 2)
                twin = next(x for x in cand if x["id"] == hit[0])
                names[hit[0]] = f"{twin['name']}, {twin['country']}"
        out[region] = f
    return out, names


def read_centres(gpkg):
    import pyogrio
    meta, _, _, fields = pyogrio.raw.read(gpkg, layer=LAYER, read_geometry=False)
    d = {n: a for n, a in zip(meta["fields"], fields)}
    g = lambda k, i: num(d[k][i])
    return [{"id": int(d["ID_UC_G0"][i]), "name": str(d["GC_UCN_MAI_2025"][i]), "country": str(d["GC_CNT_GAD_2025"][i]),
             "pop": g("GC_POP_TOT_2025", i), "t1970": g("CL_B01_CUR_1970", i),
             "now": [g(f"CL_{v}_CUR_2010", i) for v in VARS], "fut85": [g(f"CL_{v}_P85_2030", i) for v in VARS],
             "fut45": [g(f"CL_{v}_P45_2030", i) for v in VARS]} for i in range(len(d["ID_UC_G0"]))]


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, better=None, ramp="heat": FieldSpec(k, label, agg="max", unit=unit, ramp=ramp, higher_is=better)
    specs = [
        v("ct_temp_1970", "Annual mean temperature, 1970s (reanalysis)", "°C"),
        v("ct_temp_2010", "Annual mean temperature, 2010s (reanalysis)", "°C"),
        v("ct_temp_2030", "Annual mean temperature, 2030s (RCP 8.5 model mean)", "°C", "worse"),
        v("ct_temp_2030_45", "Annual mean temperature, 2030s (RCP 4.5 model mean)", "°C", "worse"),
        v("ct_rain_2010", "Annual rainfall, 2010s (reanalysis)", "mm", None, "blues"),
        v("ct_rain_2030", "Annual rainfall, 2030s (RCP 8.5 model mean)", "mm", None, "blues"),
        v("ct_twin_id", "Climate analogue: city whose 2010s climate is closest to this city's 2030s (UCDB id)", "id"),
        v("ct_twin_dist", "Distance to that analogue (standardised)", "sd"),
        v("ct_abroad_id", "Closest climate analogue outside India (UCDB id)", "id"),
        v("ct_abroad_dist", "Distance to that analogue (standardised)", "sd"),
    ]
    spec = DatasetSpec(
        id="climate_twin", title="Which city's climate will mine have in the 2030s (GHSL UCDB climate analogues)", level=LEVEL,
        fields=specs, group="Environment",
        description="Decade-average temperature and rainfall over the city's GHSL urban centre (Copernicus C3S bioclimatic "
                    "indicators, reanalysis to the 2010s and CMIP5 RCP 4.5/8.5 projections for the 2030s), and the world city of a "
                    "million or more whose 2010s climate is closest to this city's projected 2030s climate. One value per city.",
        source="pipeline/realestate/climatetwin.py (GHS_UCDB_GLOBE_R2024A V1.2, climate theme)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-UCDB R2024A); bioclimatic indicators: Copernicus Climate Change Service (Wouters 2021, doi:10.24381/cds.bce175f0)",
        default_field="ct_temp_2030", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    import json
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gpkg", required=True, help="GHS_UCDB_GLOBE_R2024A.gpkg from the V1.2 zip")
    a = ap.parse_args(argv)
    rows, names = city_rows(read_centres(a.gpkg))
    for region, f in rows.items():
        info = cell_dataset(region, f)
        print(region, f, names.get(f.get("ct_twin_id")), "/", names.get(f.get("ct_abroad_id")), info["cells"], "blocks")
    print("TWIN_NAMES =", json.dumps({str(k): v for k, v in sorted(names.items())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
