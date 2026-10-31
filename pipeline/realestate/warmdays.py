"""Unusually hot days, then and now: the share of days hotter than the city's own old normal, from the GHSL Urban Centre
Database 2025 climate theme (European Commission JRC, GHS-UCDB R2024A V1.2, CC BY 4.0; indices from the Copernicus Climate
Change Service, Sandstad et al. 2022, doi:10.24381/cds.776e08bd, Copernicus licence: free use with attribution).

The index is TX90p: the share of days whose maximum temperature beats the 90th percentile for that calendar day (5-day
window) in the 1961-1990 base period. By construction it was about 10% in the base years, so 30% means unusually hot
days have become three times as common as the old normal. The UCDB gives decade averages from reanalysis (1970s-2010s)
over the coarse grid cells touching the urban centre. It also carries CMIP6 projections for the 2020s and 2030s, but
those are raw model output on a different footing from the reanalysis (several Indian cities come out lower in the 2030s
than in the 2010s), so they are not used. Per city (dataset ``warm_days``, one value per city copied to every lived-in L7 block):

    wd_1970s / wd_1990s / wd_2010s   share of days above the old 90th percentile, by decade (reanalysis, %)
    wd_world_pctile                  share of the world's urban centres of a million or more with fewer such days in the 2010s (%)
    wd_india_pctile                  the same among India's urban centres of a million or more (%)

    python -m pipeline.realestate.warmdays --gpkg GHS_UCDB_GLOBE_R2024A.gpkg
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.landefficiency import BIG, CITY, below_share, num

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LAYER = "GHSL_UCDB_THEME_CLIMATE_GLOBE_R2024A"
COLUMNS = {"wd_1970s": "CL_WDS_CUR_1970", "wd_1990s": "CL_WDS_CUR_1990", "wd_2010s": "CL_WDS_CUR_2010"}


def city_rows(centres):
    """centres: [{name, country, pop, wd_1970s, wd_1990s, wd_2010s}] -> {region: fields}."""
    big = [c for c in centres if (c["pop"] or 0) >= BIG and c.get("wd_2010s") is not None]
    world, india = [c["wd_2010s"] for c in big], [c["wd_2010s"] for c in big if c["country"] == "India"]
    by = {c["name"]: c for c in centres if c["country"] == "India"}
    out = {}
    for region, name in CITY.items():
        c = by.get(name)
        if not c or c.get("wd_2010s") is None:
            continue
        f = {k: round(c[k], 1) for k in COLUMNS if c.get(k) is not None}
        f["wd_world_pctile"] = below_share(c["wd_2010s"], world)
        f["wd_india_pctile"] = below_share(c["wd_2010s"], india)
        out[region] = f
    return out


def read_centres(gpkg):
    import pyogrio
    meta, _, _, fields = pyogrio.raw.read(gpkg, layer=LAYER, read_geometry=False)
    d = {n: a for n, a in zip(meta["fields"], fields)}
    return [{"name": str(d["GC_UCN_MAI_2025"][i]), "country": str(d["GC_CNT_GAD_2025"][i]), "pop": num(d["GC_POP_TOT_2025"][i]),
             **{k: num(d[col][i]) for k, col in COLUMNS.items()}} for i in range(len(d["ID_UC_G0"]))]


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, better="worse": FieldSpec(k, label, agg="max", unit="%", ramp="heat", higher_is=better)
    specs = [
        v("wd_1970s", "Days hotter than the 1961-1990 normal for the date, 1970s"),
        v("wd_1990s", "Days hotter than the 1961-1990 normal for the date, 1990s"),
        v("wd_2010s", "Days hotter than the 1961-1990 normal for the date, 2010s"),
        v("wd_world_pctile", "World urban centres of 1 million+ with fewer such days in the 2010s"),
        v("wd_india_pctile", "Indian urban centres of 1 million+ with fewer such days in the 2010s"),
    ]
    spec = DatasetSpec(
        id="warm_days", title="Unusually hot days, 1970s to 2010s (GHSL UCDB, C3S TX90p)", level=LEVEL, fields=specs,
        group="Environment",
        description="Share of days with a maximum temperature above the 1961-1990 90th percentile for the date (TX90p), by decade "
                    "from reanalysis (1970s-2010s), over the city's GHSL urban centre, "
                    "from the JRC's GHS Urban Centre Database 2025 (C3S climate extreme indices). One value per city.",
        source="pipeline/realestate/warmdays.py (GHS_UCDB_GLOBE_R2024A V1.2, climate theme CL_WDS)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-UCDB R2024A); indices: Copernicus Climate Change Service (Sandstad et al. 2022, doi:10.24381/cds.776e08bd)",
        default_field="wd_2010s", extrude=False)
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
