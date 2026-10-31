"""Is the city spreading out faster than it grows: SDG 11.3.1 land use efficiency from the GHSL Urban Centre Database 2025
(European Commission JRC, GHS-UCDB R2024A V1.2, CC BY 4.0).

UN Sustainable Development Goal indicator 11.3.1 divides the land consumption rate (yearly growth of built-up land) by
the population growth rate. A ratio above 1 means built-up land grew faster than the number of people, so the city spread
out and got less dense; below 1 means it packed more people onto each hectare. The JRC computes it for each of the
world's 11,422 urban centres from GHSL's built-up and population grids (Melchiorri et al. 2019), clipped to +-5 ("<-5",
">5" in the file). An urban centre is GHSL's dense built-up area, not the municipal area. Per city (dataset
``land_efficiency``, one value per city copied to every lived-in L7 block):

    le_ratio_00_20     land consumption over population growth, 2000-2020
    le_land_pct_yr     yearly growth of built-up land, 2000-2020 (%)
    le_pop_pct_yr      yearly population growth, 2000-2020 (%)
    le_ratio_90_00     the ratio for 1990-2000
    le_ratio_10_20     the ratio for 2010-2020
    le_ratio_20_30     GHSL's projection for 2020-2030
    le_world_pctile    share of the world's urban centres of a million or more with a lower 2000-2020 ratio (%)
    le_india_pctile    the same among India's urban centres of a million or more (%)

    python -m pipeline.realestate.landefficiency --gpkg GHS_UCDB_GLOBE_R2024A.gpkg
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_UCDB_GLOBE_R2024A/GHS_UCDB_GLOBE_R2024A/V1-2/GHS_UCDB_GLOBE_R2024A_V1_2.zip"
BIG = 1_000_000
CITY = {"ahmedabad": "Ahmedabad", "bengaluru": "Bengaluru", "bhopal": "Bhopal", "chennai": "Chennai", "delhi": "New Delhi",
        "guna": "Guna", "hyderabad": "Hyderabad", "indore_pilot": "Indore", "jaipur": "Jaipur", "kolkata": "Kolkata",
        "lucknow": "Lucknow", "mumbai": "Mumbai", "pune": "Pune"}
# the file writes ratios beyond the clip as text
CLIP = {">5": 5.0, "<-5": -5.0}


def num(x):
    if x is None:
        return None
    s = str(x).strip()
    if s in CLIP:
        return CLIP[s]
    try:
        v = float(s)
    except ValueError:
        return None
    return None if math.isnan(v) else v


def below_share(value, others):
    """Share of ``others`` strictly below ``value`` (ties count half), in %."""
    xs = [o for o in others if o is not None]
    if value is None or not xs:
        return None
    lo = sum(1 for o in xs if o < value)
    eq = sum(1 for o in xs if o == value)
    return round(100 * (lo + 0.5 * eq) / len(xs))


def city_rows(centres):
    """centres: [{name, country, pop, lue_00_20, lcr, pgr, lue_90_00, lue_10_20, lue_20_30}] -> {region: fields}."""
    world = [c["lue_00_20"] for c in centres if (c["pop"] or 0) >= BIG]
    india = [c["lue_00_20"] for c in centres if (c["pop"] or 0) >= BIG and c["country"] == "India"]
    by = {c["name"]: c for c in centres if c["country"] == "India"}
    out = {}
    for region, name in CITY.items():
        c = by.get(name)
        if not c or c["lue_00_20"] is None:
            continue
        f = {"le_ratio_00_20": round(c["lue_00_20"], 2),
             "le_world_pctile": below_share(c["lue_00_20"], world), "le_india_pctile": below_share(c["lue_00_20"], india)}
        for k, src in (("le_land_pct_yr", "lcr"), ("le_pop_pct_yr", "pgr")):
            if c.get(src) is not None:
                f[k] = round(100 * c[src], 2)
        for k in ("lue_90_00", "lue_10_20", "lue_20_30"):
            if c.get(k) is not None:
                f[f"le_ratio_{k[4:]}"] = round(c[k], 2)
        out[region] = f
    return out


def read_centres(gpkg):
    import pyogrio

    def layer(theme):
        meta, _, _, fields = pyogrio.raw.read(gpkg, layer=f"GHSL_UCDB_THEME_{theme}_GLOBE_R2024A", read_geometry=False)
        return {n: a for n, a in zip(meta["fields"], fields)}
    gc, sd = layer("GENERAL_CHARACTERISTICS"), layer("SDG")
    s = {k: dict(zip(sd["ID_UC_G0"], sd[k])) for k in sd}
    out = []
    for i, uid in enumerate(gc["ID_UC_G0"]):
        g = lambda k: num(s[k].get(uid)) if k in s else None
        out.append({"name": str(gc["GC_UCN_MAI_2025"][i]), "country": str(gc["GC_CNT_GAD_2025"][i]), "pop": num(gc["GC_POP_TOT_2025"][i]),
                    "lue_00_20": g("SD_LUE_LPR_2000_2020"), "lcr": g("SD_LUE_LCR_2000_2020"), "pgr": g("SD_LUE_PGR_2000_2020"),
                    "lue_90_00": g("SD_LUE_LPR_1990_2000"), "lue_10_20": g("SD_LUE_LPR_2010_2020"), "lue_20_30": g("SD_LUE_LPR_2020_2030")})
    return out


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, better=None: FieldSpec(k, label, agg="max", unit=unit, ramp="reds", higher_is=better)
    specs = [
        v("le_ratio_00_20", "Built-up land growth over population growth, 2000-2020 (SDG 11.3.1)", "ratio", "worse"),
        v("le_land_pct_yr", "Yearly growth of built-up land, 2000-2020", "%/yr"),
        v("le_pop_pct_yr", "Yearly population growth, 2000-2020", "%/yr"),
        v("le_ratio_90_00", "Land over population growth, 1990-2000", "ratio", "worse"),
        v("le_ratio_10_20", "Land over population growth, 2010-2020", "ratio", "worse"),
        v("le_ratio_20_30", "Land over population growth, 2020-2030 (GHSL projection)", "ratio", "worse"),
        v("le_world_pctile", "World urban centres of 1 million+ with a lower 2000-2020 ratio", "%"),
        v("le_india_pctile", "Indian urban centres of 1 million+ with a lower 2000-2020 ratio", "%"),
    ]
    spec = DatasetSpec(
        id="land_efficiency", title="Spreading out or packing in (SDG 11.3.1, GHSL Urban Centre Database)", level=LEVEL, fields=specs,
        group="Real estate",
        description="The UN land use efficiency indicator (SDG 11.3.1) for the city's GHSL urban centre: yearly growth of built-up "
                    "land over yearly population growth, 2000-2020 and by decade, ranked among the world's and India's urban "
                    "centres of a million or more. From the JRC's GHS Urban Centre Database 2025 (R2024A V1.2). One value per city.",
        source="pipeline/realestate/landefficiency.py (GHS_UCDB_GLOBE_R2024A V1.2, SDG theme)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-UCDB R2024A, doi:10.2905/1a338be6-7eaf-480c-9664-3a8ade88cbcd)",
        default_field="le_ratio_00_20", extrude=False)
    codes = sorted({c[:LEVEL] for c, _, _ in lived_cells(region)})
    return store.write_dataset(CELLS, spec, region, store.bin_records(({"digipin": c, **fig} for c in codes), LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gpkg", required=True, help="GHS_UCDB_GLOBE_R2024A.gpkg from the V1.2 zip")
    a = ap.parse_args(argv)
    for region, f in city_rows(read_centres(a.gpkg)).items():
        info = cell_dataset(region, f)
        print(region, f, info["cells"], "blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
