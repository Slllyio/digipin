"""Real-estate supply per block: what was built 2016–2023, vacant buildable land, and floor-space headroom.

Per L7 cell (dataset ``re_supply``):

    new_floor_m2     floor area added 2016–2023: new buildings (Open Buildings
                     2.5D Temporal) × the cell's average 2023 footprint ×
                     storeys (2023 height ÷ 3 m)
    build_rate       new floor area per km² of land per year (construction
                     intensity; the pipeline's leading edge)
    vacant_ha        open land that could take buildings: ESA WorldCover bare
                     + grass + shrub inside the urban area (≥ 20% built
                     within ~500 m), outside water, wetland, mangrove, the
                     1-in-100-year floodplain and cells with mapped parks or
                     leisure places
    far_now          floor area ratio now (GHSL built volume ÷ 3 m ÷ land)
    headroom_m2      floor area left before the city's typical base FAR
                     (BASE_FAR; indicative master-plan level, not plot zoning)
    urban_2035_pct   projected urban share by 2035 (growth dataset, SSP)

data/realestate/<region>.json ``supply``: city totals and the busiest building
hotspots. Satellite heights are ±3 m and footprints miss small sheds; treat
the totals as orders of magnitude.

    python -m pipeline.realestate.supply --region delhi
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS
from pipeline.cells import earthengine as gee
from pipeline.realestate import land_value as lv

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
STOREY_M = 3.0
YEARS = 7.0                       # 2016 → 2023
URBAN_NEAR_PCT, URBAN_R = 20.0, 2
FLOOD_SHARE = 30.0
# Typical base FAR / FSI for residential plots in each city's current master plan or
# development-control rules (indicative city-wide level; plot rules vary by road width,
# plot size, TOD zones and purchasable premium FSI).
BASE_FAR = {"delhi": 2.0, "mumbai": 2.5, "bengaluru": 2.25, "chennai": 2.0, "hyderabad": 3.0, "pune": 2.0,
            "ahmedabad": 2.7, "kolkata": 2.0, "jaipur": 2.0, "lucknow": 2.0, "indore_pilot": 1.5,
            "bhopal": 1.5, "guna": 1.5}
DEFAULT_FAR = 2.0
TOP = 10


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def new_floor_m2(new_bldgs, cover_pct, n_2023, height_m, area_m2):
    """Floor area added by ``new_bldgs`` buildings at the cell's 2023 average footprint and storeys."""
    if not new_bldgs or new_bldgs <= 0 or not n_2023 or not cover_pct:
        return 0.0
    foot = cover_pct / 100 * area_m2 / n_2023
    storeys = max(1.0, (height_m or STOREY_M) / STOREY_M)
    return new_bldgs * foot * storeys


def vacant_share(bare, grass, shrub, water=0, wetland=0, mangrove=0):
    """Open-land share (%) of a cell that could take buildings, before exclusions."""
    open_ = (bare or 0) + (grass or 0) + (shrub or 0)
    if (water or 0) + (wetland or 0) + (mangrove or 0) >= 50:
        return 0.0
    return max(0.0, min(100.0, open_))


def headroom_m2(far_now, base_far, land_m2):
    if far_now is None or land_m2 <= 0:
        return 0.0
    return max(0.0, base_far - far_now) * land_m2


# ── run ─────────────────────────────────────────────────────────────────────

def compute(region, log=print):
    col = lambda ds, f: lv._col(ds, f, region)[0]
    nb, cover, newb, h = (col("building_stock", f) for f in ("buildings_2023", "cover_2023_pct", "new_buildings", "height_2023_m"))
    lc = {f: col("land_cover", f) for f in ("bare_pct", "grass_pct", "shrub_pct", "water_pct", "wetland_pct",
                                            "mangrove_pct", "built_pct", "tree_pct")}
    vol = col("built_up", "volume_m3_m2")
    flood = col("water", "flood_rp100_pct")
    leisure = col("osm_amenities", "leisure")
    u35 = col("growth", "urban_2035_pct")
    base = BASE_FAR.get(region, DEFAULT_FAR)
    built = lc["built_pct"]
    cells = set(nb) | set(built) | set(vol)
    rows = {}
    for c in cells:
        area = gee.cell_area_km2(c) * 1e6
        r = {}
        nf = new_floor_m2(newb.get(c), cover.get(c), nb.get(c), h.get(c), area)
        if nf > 0:
            r["new_floor_m2"] = round(nf)
            r["build_rate"] = round(nf / (area / 1e6) / YEARS)
        near = lv.disk_mean(built, c, URBAN_R) if built else None
        if near is not None and near >= URBAN_NEAR_PCT and (flood.get(c) or 0) < FLOOD_SHARE and not (leisure.get(c) or 0):
            vs = vacant_share(lc["bare_pct"].get(c), lc["grass_pct"].get(c), lc["shrub_pct"].get(c),
                              lc["water_pct"].get(c), lc["wetland_pct"].get(c), lc["mangrove_pct"].get(c))
            if vs >= 5:
                r["vacant_ha"] = round(vs / 100 * area / 1e4, 2)
        v = vol.get(c)
        if v is not None and (built.get(c) or 0) >= 10:
            far = v / STOREY_M
            r["far_now"] = round(far, 2)
            hr = headroom_m2(far, base, area * (built.get(c) or 0) / 100)
            if hr > 0:
                r["headroom_m2"] = round(hr)
        if u35.get(c) is not None:
            r["urban_2035_pct"] = round(u35[c], 1)
        if r:
            rows[c] = r
    tot = lambda k: sum(r.get(k, 0) for r in rows.values())
    hot = sorted((c for c in rows if rows[c].get("new_floor_m2")), key=lambda c: -rows[c]["new_floor_m2"])
    picks = []
    for c in hot:
        if len(picks) >= TOP:
            break
        ix = digipin.to_index(c)
        if any(abs(ix["row"] - digipin.to_index(p)["row"]) + abs(ix["col"] - digipin.to_index(p)["col"]) < 5 for p in picks):
            continue
        picks.append(c)
    summ = {"base_far": base, "new_floor_km2_2016_2023": round(tot("new_floor_m2") / 1e6, 2),
            "vacant_km2": round(tot("vacant_ha") / 100, 2), "headroom_km2": round(tot("headroom_m2") / 1e6, 1),
            "hotspots": [{"digipin": c, **rows[c]} for c in picks]}
    log(f"{region}: {json.dumps({k: v for k, v in summ.items() if k != 'hotspots'})}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("new_floor_m2", "Floor area built 2016–2023", agg="sum", unit="m²", ramp="heat"),
        FieldSpec("build_rate", "Construction intensity (floor area per km² a year)", agg="mean", unit="m²/km²/yr",
                  ramp="heat"),
        FieldSpec("vacant_ha", "Vacant buildable land", agg="sum", unit="ha", ramp="greens"),
        FieldSpec("far_now", "Floor area ratio now (approx.)", agg="mean", unit="FAR", domain=[0, 4], ramp="viridis"),
        FieldSpec("headroom_m2", "Floor area left under the city's base FAR", agg="sum", unit="m²", ramp="viridis"),
        FieldSpec("urban_2035_pct", "Projected urban share by 2035", agg="mean", unit="%", domain=[0, 100],
                  ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="re_supply", title="Real-estate supply", level=LEVEL, fields=specs, group="Real estate",
        description="What was built 2016–2023 (Open Buildings 2.5D Temporal new buildings × footprint × storeys), "
                    "vacant buildable land (ESA WorldCover bare, grass and shrub inside the urban area, outside "
                    "water, floodplain and mapped parks), floor area ratio now (GHSL volume) and the headroom "
                    "under the city's typical base FAR (indicative, not plot-level zoning), plus the 2035 urban "
                    "projection.",
        source="pipeline/realestate/supply.py over building_stock, land_cover, built_up, water, osm_amenities, growth",
        license="CC BY 4.0 (Open Buildings, ESA WorldCover, GHSL) + ODbL (OpenStreetMap)",
        default_field="build_rate", extrude=True)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    rows, summ = compute(region, log)
    if not rows:
        return None
    res = cell_dataset(region, rows)
    lv._summary(region, "supply", summ)
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
