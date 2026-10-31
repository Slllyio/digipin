"""How much home space per resident, against the world's cities: residential built-up volume per person from the GHSL
Urban Centre Database 2025 (European Commission JRC, GHS-UCDB R2024A V1.2, CC BY 4.0).

The UCDB sums GHSL's residential built-up volume (GHS-BUILT-V, building footprints from Sentinel-2 and Landsat times
heights from AW3D30/SRTM and Sentinel-2) and GHSL population (GHS-POP) over each urban centre, every five years. Volume
per resident is a proxy for home floor space per person: dividing by a storey height of about 3 m gives a rough floor
area, which counts walls, stairs and empty flats too, so it is an upper bound and best used for comparisons. The UCDB also
counts residents by the prevalent height of the residential area they live in (2020). Per city (dataset ``room_rank``,
one value per city copied to every lived-in L7 block):

    rr_m3_pp_2020     residential built-up volume per resident, 2020 (m3)
    rr_m3_pp_2000     the same in 2000 (m3)
    rr_change_pct     change 2000-2020 (%)
    rr_floor_m2_pp    rough floor area per resident, 2020 (volume / 3 m)
    rr_world_pctile   share of the world's urban centres of a million or more with less volume per resident (%)
    rr_india_pctile   the same among India's urban centres of a million or more (%)
    rr_low_pct / rr_mid_pct / rr_high_pct  residents in areas of mostly 1-2, 3-7 and 8+ floor homes, 2020 (%)

    python -m pipeline.realestate.roomrank --gpkg GHS_UCDB_GLOBE_R2024A.gpkg
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.landefficiency import BIG, CITY, below_share, num

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LAYER = "GHSL_UCDB_THEME_GHSL_GLOBE_R2024A"
STOREY_M = 3.0


def per_person(volume, pop):
    return volume / pop if volume and pop else None


def city_rows(centres):
    """centres: [{name, country, pop, v2000, p2000, v2020, p2020, low, mid, high}] -> {region: fields}."""
    for c in centres:
        c["pp"] = per_person(c["v2020"], c["p2020"])
    big = [c for c in centres if (c["pop"] or 0) >= BIG and c["pp"] is not None]
    world, india = [c["pp"] for c in big], [c["pp"] for c in big if c["country"] == "India"]
    by = {c["name"]: c for c in centres if c["country"] == "India"}
    out = {}
    for region, name in CITY.items():
        c = by.get(name)
        if not c or c["pp"] is None:
            continue
        f = {"rr_m3_pp_2020": round(c["pp"]), "rr_floor_m2_pp": round(c["pp"] / STOREY_M),
             "rr_world_pctile": below_share(c["pp"], world), "rr_india_pctile": below_share(c["pp"], india)}
        then = per_person(c["v2000"], c["p2000"])
        if then:
            f["rr_m3_pp_2000"] = round(then)
            f["rr_change_pct"] = round(100 * (c["pp"] / then - 1))
        tiers = [c.get(k) or 0 for k in ("low", "mid", "high")]
        if sum(tiers) > 0:
            for k, x in zip(("rr_low_pct", "rr_mid_pct", "rr_high_pct"), tiers):
                f[k] = round(100 * x / sum(tiers))
        out[region] = f
    return out


def read_centres(gpkg):
    import pyogrio
    meta, _, _, fields = pyogrio.raw.read(gpkg, layer=LAYER, read_geometry=False)
    d = {n: a for n, a in zip(meta["fields"], fields)}
    g = lambda k, i: num(d[k][i])
    return [{"name": str(d["GC_UCN_MAI_2025"][i]), "country": str(d["GC_CNT_GAD_2025"][i]), "pop": g("GC_POP_TOT_2025", i),
             "v2000": g("GH_BUV_RES_2000", i), "p2000": g("GH_POP_TOT_2000", i), "v2020": g("GH_BUV_RES_2020", i),
             "p2020": g("GH_POP_TOT_2020", i), "low": g("GH_BUT_P11_2020", i), "mid": g("GH_BUT_P12_2020", i),
             "high": g("GH_BUT_P13_2020", i)} for i in range(len(d["ID_UC_G0"]))]


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    v = lambda k, label, unit, better="better": FieldSpec(k, label, agg="max", unit=unit, ramp="viridis", higher_is=better)
    specs = [
        v("rr_m3_pp_2020", "Residential built-up volume per resident, 2020", "m³"),
        v("rr_m3_pp_2000", "Residential built-up volume per resident, 2000", "m³"),
        v("rr_change_pct", "Change in residential volume per resident, 2000-2020", "%"),
        v("rr_floor_m2_pp", "Rough home floor area per resident, 2020 (volume / 3 m)", "m²"),
        v("rr_world_pctile", "World urban centres of 1 million+ with less home volume per resident", "%"),
        v("rr_india_pctile", "Indian urban centres of 1 million+ with less home volume per resident", "%"),
        v("rr_low_pct", "Residents in areas of mostly 1-2 floor homes, 2020", "%", None),
        v("rr_mid_pct", "Residents in areas of mostly 3-7 floor homes, 2020", "%", None),
        v("rr_high_pct", "Residents in areas of mostly 8+ floor homes, 2020", "%", None),
    ]
    spec = DatasetSpec(
        id="room_rank", title="Home space per resident against the world's cities (GHSL Urban Centre Database)", level=LEVEL,
        fields=specs, group="Real estate",
        description="Residential built-up volume per resident in the city's GHSL urban centre in 2000 and 2020, a rough floor "
                    "area per person, its rank among the world's and India's urban centres of a million or more, and the share "
                    "of residents in low, mid and high-rise residential areas, from the JRC's GHS Urban Centre Database 2025. "
                    "One value per city.",
        source="pipeline/realestate/roomrank.py (GHS_UCDB_GLOBE_R2024A V1.2, GHSL theme)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-UCDB R2024A, doi:10.2905/1a338be6-7eaf-480c-9664-3a8ade88cbcd)",
        default_field="rr_m3_pp_2020", extrude=False)
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
