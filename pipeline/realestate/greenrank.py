"""Greener or greyer than the world's cities: greenness and tree height in the built-up area, from the GHSL Urban Centre
Database 2025 (European Commission JRC, GHS-UCDB R2024A V1.2, CC BY 4.0).

The UCDB's greenness theme gives, for each of the world's 11,422 urban centres, the mean Landsat NDVI (a 0-1 index of
green leaf; bare ground and roofs sit near 0.1, lawns and crops 0.3-0.6, dense trees above 0.6) over the built-up area
and a 300 m buffer around it, every five years from 1985 to 2025 (three-year averages), and the mean canopy top height
there in 2020 (Lang et al.'s 10 m global canopy height model). Climate sets much of it: a monsoon city is greener than
a desert one with the same parks, so the city is also ranked among India's own urban centres. An urban centre is GHSL's
dense built-up area, not the municipal area. Per city (dataset ``green_rank``, one value per city copied to every
lived-in L7 block):

    gr_ndvi_2025       mean NDVI in the built-up area, 2025
    gr_ndvi_2000       the same in 2000
    gr_ndvi_change_pct change 2000-2025 (%)
    gr_world_pctile    share of the world's urban centres of a million or more with a lower 2025 NDVI (%)
    gr_india_pctile    the same among India's urban centres of a million or more (%)
    gr_canopy_m        mean canopy top height in the built-up area, 2020 (m)
    gr_canopy_world_pctile  share of the world's million-plus urban centres with lower canopy (%)

    python -m pipeline.realestate.greenrank --gpkg GHS_UCDB_GLOBE_R2024A.gpkg
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.landefficiency import BIG, CITY, below_share, num

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LAYER = "GHSL_UCDB_THEME_GREENNESS_GLOBE_R2024A"


def city_rows(centres):
    """centres: [{name, country, pop, ndvi_2000, ndvi_2025, canopy}] -> {region: fields}."""
    big = [c for c in centres if (c["pop"] or 0) >= BIG]
    world = [c["ndvi_2025"] for c in big]
    india = [c["ndvi_2025"] for c in big if c["country"] == "India"]
    canopy = [c["canopy"] for c in big]
    by = {c["name"]: c for c in centres if c["country"] == "India"}
    out = {}
    for region, name in CITY.items():
        c = by.get(name)
        if not c or c["ndvi_2025"] is None:
            continue
        f = {"gr_ndvi_2025": round(c["ndvi_2025"], 3), "gr_world_pctile": below_share(c["ndvi_2025"], world),
             "gr_india_pctile": below_share(c["ndvi_2025"], india)}
        if c.get("ndvi_2000"):
            f["gr_ndvi_2000"] = round(c["ndvi_2000"], 3)
            f["gr_ndvi_change_pct"] = round(100 * (c["ndvi_2025"] / c["ndvi_2000"] - 1))
        if c.get("canopy") is not None:
            f["gr_canopy_m"] = round(c["canopy"], 1)
            f["gr_canopy_world_pctile"] = below_share(c["canopy"], canopy)
        out[region] = f
    return out


def read_centres(gpkg):
    import pyogrio
    meta, _, _, fields = pyogrio.raw.read(gpkg, layer=LAYER, read_geometry=False)
    d = {n: a for n, a in zip(meta["fields"], fields)}
    return [{"name": str(d["GC_UCN_MAI_2025"][i]), "country": str(d["GC_CNT_GAD_2025"][i]), "pop": num(d["GC_POP_TOT_2025"][i]),
             "ndvi_2000": num(d["GR_AVG_GRN_2000"][i]), "ndvi_2025": num(d["GR_AVG_GRN_2025"][i]), "canopy": num(d["GR_CTH_AVG_2020"][i])}
            for i in range(len(d["ID_UC_G0"]))]


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, better="better": FieldSpec(k, label, agg="max", unit=unit, ramp="greens", higher_is=better)
    specs = [
        v("gr_ndvi_2025", "Mean greenness (NDVI) in the built-up area, 2025", "NDVI"),
        v("gr_ndvi_2000", "Mean greenness (NDVI) in the built-up area, 2000", "NDVI"),
        v("gr_ndvi_change_pct", "Change in built-up greenness, 2000-2025", "%"),
        v("gr_world_pctile", "World urban centres of 1 million+ less green in 2025", "%"),
        v("gr_india_pctile", "Indian urban centres of 1 million+ less green in 2025", "%"),
        v("gr_canopy_m", "Mean tree canopy height in the built-up area, 2020", "m"),
        v("gr_canopy_world_pctile", "World urban centres of 1 million+ with lower canopy", "%"),
    ]
    spec = DatasetSpec(
        id="green_rank", title="Greener or greyer than the world's cities (GHSL Urban Centre Database)", level=LEVEL, fields=specs,
        group="Environment",
        description="Mean Landsat greenness (NDVI) over the city's built-up area in 2000 and 2025 and mean tree canopy height in "
                    "2020, ranked among the world's and India's urban centres of a million or more, from the JRC's GHS Urban "
                    "Centre Database 2025 (R2024A V1.2). Climate sets much of it, so compare with Indian peers too. One value per city.",
        source="pipeline/realestate/greenrank.py (GHS_UCDB_GLOBE_R2024A V1.2, greenness theme)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-UCDB R2024A, doi:10.2905/1a338be6-7eaf-480c-9664-3a8ade88cbcd)",
        default_field="gr_ndvi_2025", extrude=False)
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
