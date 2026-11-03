"""Which safe and just Earth system boundaries the city's land crosses: the Earth Commission's transgression map (Rockström
et al. 2023, Nature; data Abrams 2022, figshare doi:10.6084/m9.figshare.20079200, CC BY 4.0) summarised per urban centre in
the GHSL Urban Centre Database 2025 natural systems theme (European Commission JRC, GHS-UCDB R2024A V1.2, CC BY 4.0).

The Earth Commission set "safe and just" limits for the planet's life-support systems and mapped where on land each is
crossed, at about 50 km: biosphere integrity (too little intact natural land), nitrogen and phosphorus (fertiliser
surplus), surface water flows and groundwater decline, aerosols (annual PM2.5 above 15 µg/m3), climate (wet-bulb heat
that harms people) and sea level rise exposure. The UCDB flags each boundary that any part of the urban centre crosses
and the least and most boundaries crossed at one spot. Per city (dataset ``earth_bounds``, one value per city copied to
every lived-in L7 block):

    eb_max / eb_min        most and fewest boundaries crossed at one spot in the urban centre
    eb_<boundary>          1 when the boundary is crossed somewhere in the centre: bio, gwa, nit, pho, p25, slr, swa, wet
    eb_world_pctile        share of the world's urban centres of a million or more with a lower eb_max (%)

    python -m pipeline.realestate.earthbounds --gpkg GHS_UCDB_GLOBE_R2024A.gpkg
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pipeline.realestate.landefficiency import BIG, CITY, below_share, num

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LAYER = "GHSL_UCDB_THEME_NATURAL_SYSTEMS_GLOBE_R2024A"
BOUNDS = {"bio": "too little intact nature", "gwa": "groundwater decline", "nit": "nitrogen surplus", "pho": "phosphorus surplus",
          "p25": "fine-particle air pollution", "slr": "sea level rise", "swa": "surface water flows", "wet": "wet-bulb heat"}


def city_rows(centres):
    """centres: [{name, country, pop, max, min, bio, gwa, ...}] -> {region: fields}."""
    world = [c["max"] for c in centres if (c["pop"] or 0) >= BIG and c.get("max") is not None]
    by = {c["name"]: c for c in centres if c["country"] == "India"}
    out = {}
    for region, name in CITY.items():
        c = by.get(name)
        if not c or c.get("max") is None:
            continue
        f = {"eb_max": int(c["max"]), "eb_world_pctile": below_share(c["max"], world)}
        if c.get("min") is not None:
            f["eb_min"] = int(c["min"])
        for k in BOUNDS:
            if c.get(k) is not None:
                f[f"eb_{k}"] = 1 if c[k] > 0 else 0
        out[region] = f
    return out


def read_centres(gpkg):
    import pyogrio
    meta, _, _, fields = pyogrio.raw.read(gpkg, layer=LAYER, read_geometry=False)
    d = {n: a for n, a in zip(meta["fields"], fields)}
    col = lambda k, i: num(d[f"NS_ESB_{k.upper()}_2025"][i])
    return [{"name": str(d["GC_UCN_MAI_2025"][i]), "country": str(d["GC_CNT_GAD_2025"][i]), "pop": num(d["GC_POP_TOT_2025"][i]),
             **{k: col(k, i) for k in (*BOUNDS, "max", "min")}} for i in range(len(d["ID_UC_G0"]))]


def cell_dataset(region, fig):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.realestate.powerplants import lived_cells
    specs = [FieldSpec("eb_max", "Most Earth system boundaries crossed at one spot in the city", agg="max", unit="of 8", ramp="reds", higher_is="worse"),
             FieldSpec("eb_min", "Fewest Earth system boundaries crossed at one spot in the city", agg="max", unit="of 8", ramp="reds", higher_is="worse"),
             FieldSpec("eb_world_pctile", "World urban centres of 1 million+ crossing fewer boundaries", agg="max", unit="%", ramp="reds", higher_is="worse")]
    specs += [FieldSpec(f"eb_{k}", f"Boundary crossed: {label}", agg="max", unit="0/1", domain=[0, 1], ramp="reds", higher_is="worse")
              for k, label in BOUNDS.items()]
    spec = DatasetSpec(
        id="earth_bounds", title="Safe and just Earth system boundaries crossed (Earth Commission, via GHSL UCDB)", level=LEVEL,
        fields=specs, group="Environment",
        description="Which of the Earth Commission's eight safe and just Earth system boundaries (Rockström et al. 2023) the land "
                    "under the city's GHSL urban centre crosses, and the most and fewest crossed at one spot, from the JRC's GHS "
                    "Urban Centre Database 2025. About 50 km resolution. One value per city.",
        source="pipeline/realestate/earthbounds.py (GHS_UCDB_GLOBE_R2024A V1.2, natural systems theme NS_ESB)",
        license="CC BY 4.0 (European Commission, Joint Research Centre, GHS-UCDB R2024A; J. Abrams, Transgression map, figshare doi:10.6084/m9.figshare.20079200)",
        default_field="eb_max", extrude=False)
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
