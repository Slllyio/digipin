"""Building dynamics per block from Earth Engine's building prediction datasets.

Per L7 cell (dataset ``building_dynamics``):

    build_year        median year of the buildings added 2016–2023 (Open
                      Buildings 2.5D Temporal yearly counts)
    accel             construction acceleration: buildings added a year in
                      2020–2023 ÷ in 2016–2020, relative to the city's median
                      block (>1 = speeding up faster than the city; the
                      model's later years detect more, so raw ratios run high)
    height_change_m   change in mean building height 2016→2023 (vertical
                      growth: redevelopment and added floors)
    settled_year      mean year the block's settled pixels first appear in the
                      World Settlement Footprint Evolution (1985 = by 1985)
    built_1975_pct    built-up share of the block in 1975 (GHSL BUILT_S): the
                      old core
    built_2030_pct    GHSL's projected built-up share for 2030
    proj_gain_pp      projected gain 2020→2030 (percentage points)
    nonres_pct        non-residential share of built-up surface (GHSL 2020)
    highrise_pct      share of built-up area in buildings over 15 m (GHSL
                      BUILT_C 2018 morphological classes)
    dw_built_change   Dynamic World built-area probability, 2026 minus 2023
                      (construction since the last Open Buildings year)

    python -m pipeline.realestate.building_dynamics --region delhi
"""
from __future__ import annotations

import argparse
import itertools
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS
from pipeline.cells import earthengine as gee
from pipeline.cells import ee_layers as el

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
YEARS = list(range(2016, 2024))
EPOCHS = (1975, 2020, 2030)
DW_BEFORE, DW_AFTER = ("2023-01-01", "2023-10-01"), ("2026-01-01", "2026-10-01")
MIN_NEW = 3


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def build_year(counts: dict):
    """Median year of buildings added, from {year: count}; None with fewer than MIN_NEW added."""
    ys = sorted(y for y, v in counts.items() if v is not None)
    adds = []
    for a, b in itertools.pairwise(ys):
        adds.append((b, max(0.0, counts[b] - counts[a])))
    tot = sum(v for _, v in adds)
    if tot < MIN_NEW:
        return None
    cum = 0.0
    for y, v in adds:
        cum += v
        if cum >= tot / 2:
            return y
    return ys[-1]


def acceleration(counts: dict):
    """Buildings added a year in 2020–2023 ÷ in 2016–2020; None when the early pace is too thin."""
    n16, n20, n23 = counts.get(2016), counts.get(2020), counts.get(2023)
    if None in (n16, n20, n23):
        return None
    early, late = max(0.0, n20 - n16) / 4, max(0.0, n23 - n20) / 3
    if early * 4 < MIN_NEW:
        return None
    return late / early


# ── run ─────────────────────────────────────────────────────────────────────

def _open_buildings(ee, geom, bbox):
    col = ee.ImageCollection("GOOGLE/Research/open-buildings-temporal/v1").filterBounds(geom)
    bands = []
    for y in YEARS:
        c = col.filter(ee.Filter.calendarRange(y, y, "year"))
        m = c.mosaic().setDefaultProjection(c.first().projection().atScale(4))
        bands.append(m.select("building_fractional_count").rename(f"n{y}"))
        if y in (2016, 2023):
            pres, h = m.select("building_presence"), m.select("building_height")
            bands.append(h.updateMask(pres.gte(0.5).And(h.gt(0))).rename(f"h{y}"))
    return gee.fetch(gee.to_cells(ee.Image.cat(bands), 4), bbox, LEVEL, tile=48)


def _ghsl_wsf(ee, bbox):
    s = {y: ee.Image(f"JRC/GHSL/P2023A/GHS_BUILT_S/{y}") for y in EPOCHS}
    # built_surface is m² per 100 m pixel: ÷100 → % of the pixel.
    img = ee.Image.cat(
        [s[y].select("built_surface").divide(100).rename(f"b{y}") for y in EPOCHS]
        + [s[2020].select("built_surface_nres").divide(100).rename("nres2020")])
    a = gee.fetch(gee.to_cells(img, 100), bbox, LEVEL)
    bc = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_C/2018").select("built_characteristics")
    built = bc.gte(11)
    high = bc.eq(14).Or(bc.eq(15)).Or(bc.eq(24)).Or(bc.eq(25))
    b = gee.fetch(gee.to_cells(ee.Image.cat([built.rename("bc_built"), high.rename("bc_high")]), 10), bbox, LEVEL)
    wsf = ee.ImageCollection("projects/sat-io/open-datasets/WSF/WSF_EVO").mosaic().select("b1")
    c = gee.fetch(gee.to_cells(wsf.updateMask(wsf.gt(0)).rename("wsf_year"), 30), bbox, LEVEL)
    return gee.merge(a, b, c)


def _dynamic_world(ee, geom, bbox):
    dw = ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1").filterBounds(geom).select("built")
    img = ee.Image.cat([dw.filterDate(*DW_BEFORE).mean().rename("dw0"), dw.filterDate(*DW_AFTER).mean().rename("dw1")])
    return gee.fetch(gee.to_cells(img, 10), bbox, LEVEL, tile=64)


def compute(region, log=print):
    ee = gee.init()
    geom, bbox = el._bbox(region)
    log(f"{region}: Open Buildings yearly")
    ob = _open_buildings(ee, geom, bbox)
    log(f"{region}: GHSL + WSF")
    gh = _ghsl_wsf(ee, bbox)
    log(f"{region}: Dynamic World")
    try:
        dw = _dynamic_world(ee, geom, bbox)
    except Exception as e:  # noqa: BLE001 - a heavy optional layer; the rest still stands
        log(f"{region}: Dynamic World skipped ({str(e)[:80]})")
        dw = {}
    rows = {}
    for code in set(ob) | set(gh):
        x, g, d = ob.get(code, {}), gh.get(code, {}), dw.get(code, {})
        r = {}
        k = gee.cell_area_km2(code) * 1e6 / 0.25
        counts = {y: x[f"n{y}"] * k for y in YEARS if x.get(f"n{y}") is not None}
        if counts:
            r["build_year"] = build_year(counts)
            a = acceleration(counts)
            r["accel"] = el._r(a, 2) if a is not None else None
        if x.get("h2016") is not None and x.get("h2023") is not None:
            r["height_change_m"] = el._r(x["h2023"] - x["h2016"])
        if g.get("wsf_year") is not None:
            r["settled_year"] = round(g["wsf_year"])
        if g.get("b2020") is not None:
            r["built_1975_pct"] = el._r(g.get("b1975"))
            r["built_2030_pct"] = el._r(g.get("b2030"))
            if g.get("b2030") is not None:
                r["proj_gain_pp"] = el._r(g["b2030"] - g["b2020"])
            if g["b2020"] >= 5 and g.get("nres2020") is not None:
                r["nonres_pct"] = el._r(min(100.0, 100 * g["nres2020"] / g["b2020"]))
        if g.get("bc_built") and g["bc_built"] >= 0.05:
            r["highrise_pct"] = el._r(100 * (g.get("bc_high") or 0) / g["bc_built"])
        if d.get("dw0") is not None and d.get("dw1") is not None:
            r["dw_built_change"] = el._r(100 * (d["dw1"] - d["dw0"]))
        r = {k2: v for k2, v in r.items() if v is not None}
        if r:
            rows[code] = r
    acc = sorted(r["accel"] for r in rows.values() if r.get("accel"))
    med = acc[len(acc) // 2] if acc else None
    if med:
        for r in rows.values():
            if r.get("accel") is not None:
                r["accel"] = el._r(r["accel"] / med, 2)
    log(f"{region}: {len(rows)} cells, median raw acceleration {med}")
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("build_year", "Median year of new buildings (2017–2023)", agg="mean", unit="year",
                  domain=[2017, 2023], ramp="viridis"),
        FieldSpec("accel", "Construction acceleration vs the city (2020–23 pace ÷ 2016–20)", agg="mean", unit="×",
                  domain=[0, 3], ramp="diverging"),
        FieldSpec("height_change_m", "Change in mean building height 2016→2023", agg="mean", unit="m",
                  domain=[-3, 6], ramp="diverging"),
        FieldSpec("settled_year", "Year first settled (WSF Evolution; 1985 = by 1985)", agg="mean", unit="year",
                  domain=[1985, 2015], ramp="viridis"),
        FieldSpec("built_1975_pct", "Built-up in 1975", agg="mean", unit="%", domain=[0, 100], ramp="heat"),
        FieldSpec("built_2030_pct", "Built-up projected for 2030 (GHSL)", agg="mean", unit="%", domain=[0, 100],
                  ramp="heat"),
        FieldSpec("proj_gain_pp", "Projected built-up gain 2020→2030 (GHSL)", agg="mean", unit="pp",
                  domain=[0, 30], ramp="reds"),
        FieldSpec("nonres_pct", "Non-residential share of built-up (GHSL 2020)", agg="mean", unit="%",
                  domain=[0, 100], ramp="viridis"),
        FieldSpec("highrise_pct", "Built-up in buildings over 15 m (GHSL 2018)", agg="mean", unit="%",
                  domain=[0, 60], ramp="viridis"),
        FieldSpec("dw_built_change", "Built-area probability change 2023→2026 (Dynamic World)", agg="mean",
                  unit="pp", domain=[-10, 30], ramp="diverging"),
    ]
    spec = DatasetSpec(
        id="building_dynamics", title="Building dynamics", level=LEVEL, fields=specs, group="Real estate",
        description="When and how fast each block was built, from Earth Engine's building prediction datasets: "
                    "Google Open Buildings 2.5D Temporal yearly counts and heights (2016–2023), the World "
                    "Settlement Footprint Evolution (1985–2015), GHSL built-up surface for 1975, 2020 and its "
                    "2030 projection, GHSL 2018 building-height and use classes, and Dynamic World built-area "
                    "probability for 2023 and 2026. Model outputs: counts and heights carry several metres "
                    "and a few buildings of error per block.",
        source="pipeline/realestate/building_dynamics.py via Earth Engine (GOOGLE/Research/open-buildings-temporal/v1, "
               "JRC/GHSL/P2023A, projects/sat-io/open-datasets/WSF/WSF_EVO, GOOGLE/DYNAMICWORLD/V1)",
        license="CC BY 4.0 (Open Buildings, GHSL, WSF Evolution, Dynamic World)",
        default_field="build_year", extrude=True)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    rows = compute(region, log)
    return cell_dataset(region, rows) if rows else None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
