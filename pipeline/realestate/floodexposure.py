"""Has the city grown into its floodplain: residents in river and coastal flood zones from the GHSL Urban Centre Database
2025 exposure theme (European Commission JRC, GHS-UCDB R2024A V1.2, CC BY 4.0).

The UCDB overlays GHSL population grids (GHS-POP, every five years from 1975) on hazard maps for each urban centre:

    river floods    JRC GloFAS modelled inundation for 10 and 100-year return periods (Baugh et al. 2024, CC BY 4.0)
    coastal floods  JRC extreme sea level flood maps, 100-year return period (Vousdoukas et al. 2018)
    low coast       CIESIN/SEDAC Low Elevation Coastal Zone v3, land under 5 m and 10 m (CC BY 4.0)

Population for 2025 and 2030 is a GHSL projection, so 2020 is the latest year used. A flood map is a model of where water
would reach in a rare flood without defences, at about 90 m: it does not see drains, embankments or local waterlogging.
Per city (dataset ``flood_exposure``, one value per city copied to every lived-in L7 block):

    fx_river100_pct        residents in the 100-year river flood zone, 2020 (%)
    fx_river100_1975_pct   the same in 1975 (%)
    fx_river100_2000_pct   the same in 2000 (%)
    fx_river100_people     residents in the 100-year river flood zone, 2020
    fx_river10_pct         residents in the 10-year river flood zone, 2020 (%)
    fx_coast100_pct        residents in the 100-year coastal flood zone, 2020 (%)
    fx_lecz5_pct / fx_lecz10_pct  residents on land under 5 m / 10 m above sea level, 2020 (%)
    fx_world_pctile        share of the world's urban centres of a million or more with fewer residents (as a share) in the
                           100-year river flood zone (%)
    fx_india_pctile        the same among India's urban centres of a million or more (%)

    python -m pipeline.realestate.floodexposure --gpkg GHS_UCDB_GLOBE_R2024A.gpkg
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.landefficiency import BIG, CITY, below_share, num

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LAYER = "GHSL_UCDB_THEME_EXPOSURE_GLOBE_R2024A"
YEAR = 2020
COLUMNS = {"river100": f"EX_100_SHP_{YEAR}", "river100_1975": "EX_100_SHP_1975", "river100_2000": "EX_100_SHP_2000",
           "river100_people": f"EX_100_POP_{YEAR}", "river10": f"EX_010_SHP_{YEAR}", "coast100": f"EX_CF1_SHP_{YEAR}",
           "lecz5": f"EX_L05_SHP_{YEAR}", "lecz10": f"EX_LEC_SHP_{YEAR}"}


def city_rows(centres):
    """centres: [{name, country, pop, river100, river100_1975, ...}] -> {region: fields}."""
    big = [c for c in centres if (c["pop"] or 0) >= BIG and c.get("river100") is not None]
    world, india = [c["river100"] for c in big], [c["river100"] for c in big if c["country"] == "India"]
    by = {c["name"]: c for c in centres if c["country"] == "India"}
    out = {}
    for region, name in CITY.items():
        c = by.get(name)
        if not c or c.get("river100") is None:
            continue
        f = {"fx_world_pctile": below_share(c["river100"], world), "fx_india_pctile": below_share(c["river100"], india)}
        for k in COLUMNS:
            x = c.get(k)
            if x is not None:
                f[f"fx_{k}" if k == "river100_people" else f"fx_{k}_pct"] = round(x, -3) if k == "river100_people" else round(x, 1)
        out[region] = f
    return out


def read_centres(gpkg):
    import pyogrio
    meta, _, _, fields = pyogrio.raw.read(gpkg, layer=LAYER, read_geometry=False)
    d = {n: a for n, a in zip(meta["fields"], fields)}
    return [{"name": str(d["GC_UCN_MAI_2025"][i]), "country": str(d["GC_CNT_GAD_2025"][i]), "pop": num(d["GC_POP_TOT_2025"][i]),
             **{k: num(d[col][i]) for k, col in COLUMNS.items() if col in d}} for i in range(len(d["ID_UC_G0"]))]


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit="%", better="worse": FieldSpec(k, label, agg="max", unit=unit, ramp="blues", higher_is=better)
    specs = [
        v("fx_river100_pct", "Residents in the 100-year river flood zone, 2020"),
        v("fx_river100_1975_pct", "Residents in the 100-year river flood zone, 1975"),
        v("fx_river100_2000_pct", "Residents in the 100-year river flood zone, 2000"),
        v("fx_river100_people", "People in the 100-year river flood zone, 2020", "people"),
        v("fx_river10_pct", "Residents in the 10-year river flood zone, 2020"),
        v("fx_coast100_pct", "Residents in the 100-year coastal flood zone, 2020"),
        v("fx_lecz5_pct", "Residents on land under 5 m above sea level, 2020"),
        v("fx_lecz10_pct", "Residents on land under 10 m above sea level, 2020"),
        v("fx_world_pctile", "World urban centres of 1 million+ with a smaller share in the 100-year river flood zone"),
        v("fx_india_pctile", "Indian urban centres of 1 million+ with a smaller share in the 100-year river flood zone"),
    ]
    spec = DatasetSpec(
        id="flood_exposure", title="Residents in flood zones since 1975 against the world's cities (GHSL Urban Centre Database)",
        level=LEVEL, fields=specs, group="Environment",
        description="Share of the city's residents in the JRC GloFAS 10 and 100-year river flood zones, the 100-year coastal flood "
                    "zone and the low elevation coastal zone, 1975-2020, ranked among the world's and India's urban centres of a "
                    "million or more, from the JRC's GHS Urban Centre Database 2025 exposure theme. One value per city.",
        source="pipeline/realestate/floodexposure.py (GHS_UCDB_GLOBE_R2024A V1.2, exposure theme)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-UCDB R2024A; GloFAS flood hazard maps; CIESIN LECZ v3)",
        default_field="fx_river100_pct", extrude=False)
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
