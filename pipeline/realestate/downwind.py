"""Smoke and dust downwind of landfills and industrial land, per block (OSM land use × ERA5-Land wind).

Per L7 lived-in block (dataset ``downwind``):

    landfill_smoke   sum over landfill and dump blocks (LANDFILL_MIN_HA+ of dump land) within LANDFILL_KM of their landfill area (ha) × the share of the
                     wind blowing from them towards the block (±45°, speed-weighted daily means) ÷ distance (km, at least
                     MIN_KM). Landfill fires (Ghazipur, Deonar, Perungudi, Brahmapuram) and odour travel with the wind.
    industry_smoke   the same over industrial land within INDUSTRY_KM (blocks with INDUSTRY_PCT+ industrial)
    landfill_upwind  share of the wind that reaches the block after crossing a landfill block within LANDFILL_KM (%)

Land use comes from the ``landuse`` cell dataset (OSM via Overture); wind is one ERA5-Land daily wind rose per city
(pipeline/realestate/powerplants.py). Relative indices, not concentrations.

    python -m pipeline.realestate.downwind --region all
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
LANDFILL_KM, INDUSTRY_KM = 3, 3
LANDFILL_MIN_HA = 2            # ignore slivers of mapped dump land
INDUSTRY_PCT = 10
MIN_KM = 0.5
BINS = 72                       # 5° bins of the wind rose


def sector_table(rose_, sector_deg=45):
    """Share of the wind moving within ±sector_deg of each 5° bearing bin."""
    import numpy as np
    d = np.array([x for x, _ in rose_]) if rose_ else np.zeros(0)
    w = np.array([y for _, y in rose_]) if rose_ else np.zeros(0)
    out = np.zeros(BINS)
    for b in range(BINS):
        centre = b * 360 / BINS
        out[b] = w[np.abs((d - centre + 180) % 360 - 180) <= sector_deg].sum()
    return out


def smoke(targets, sources, table, reach_km, lat0):
    """targets [(lat, lng)], sources [(lat, lng, weight)] → (index per target, upwind share per target)."""
    import numpy as np
    if not sources or not len(targets):
        return np.zeros(len(targets)), np.zeros(len(targets))
    kx = 111.32 * math.cos(math.radians(lat0))
    ty = np.array([t[0] for t in targets]) * 110.57
    tx = np.array([t[1] for t in targets]) * kx
    idx = np.zeros(len(targets))
    up = np.zeros(len(targets))
    for sy, sx, wt in sources:
        dy, dx = ty - sy * 110.57, tx - sx * kx
        d = np.hypot(dx, dy)
        m = d <= reach_km
        if not m.any():
            continue
        brg = (np.degrees(np.arctan2(dx[m], dy[m])) + 360) % 360       # bearing source → target
        share = table[(np.round(brg / (360 / BINS)).astype(int)) % BINS]
        idx[m] += wt * share / np.maximum(d[m], MIN_KM)
        up[m] = np.maximum(up[m], share)
    return idx, up


def _table(region, field):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == field[0])
    entry = next((r for r in ds["regions"] if r["name"] == region), None)
    if entry is None:
        return None
    return store.read_region(CELLS, entry)


def _centre(code):
    from pipeline.cells import store
    b = store.cell_bounds(code)
    return (b["south"] + b["north"]) / 2, (b["west"] + b["east"]) / 2, b


def compute(region, ee):
    from pipeline.realestate.parks import deg2_to_m2
    from pipeline.realestate.powerplants import fetch_wind, rose
    from pipeline._lib.regions import bbox_for
    pop = _table(region, ("population",))
    lu = _table(region, ("landuse",))
    if pop is None or lu is None:
        return {}
    w, s, e, n = bbox_for(region)
    table = sector_table(rose(fetch_wind(ee, (s + n) / 2, (w + e) / 2)))
    fills, inds = [], []
    lf, ind = lu.columns["landfill_pct"], lu.columns["industrial_pct"]
    for k, code in enumerate(lu.codes):
        a, b = lf[k] or 0, ind[k] or 0
        if a <= 0 and b < INDUSTRY_PCT:
            continue
        y, x, bb = _centre(code)
        ha = deg2_to_m2((bb["east"] - bb["west"]) * (bb["north"] - bb["south"]), y) / 1e4
        if ha * a / 100 >= LANDFILL_MIN_HA:
            fills.append((y, x, ha * a / 100))
        if b >= INDUSTRY_PCT:
            inds.append((y, x, ha * b / 100))
    targets = [_centre(c)[:2] for c in pop.codes]
    lat0 = (s + n) / 2
    li, lu_up = smoke(targets, fills, table, LANDFILL_KM, lat0)
    ii, _ = smoke(targets, inds, table, INDUSTRY_KM, lat0)
    return {c: {"landfill_smoke": round(float(li[j]), 2), "industry_smoke": round(float(ii[j]), 2),
                "landfill_upwind": round(100 * float(lu_up[j]), 1)} for j, c in enumerate(pop.codes)}


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("landfill_smoke", "Landfill smoke downwind (ha × wind share ÷ km)", agg="max", unit="index", ramp="reds", higher_is="worse"),
        FieldSpec("industry_smoke", "Industrial smoke downwind (ha × wind share ÷ km)", agg="max", unit="index", ramp="reds", higher_is="worse"),
        FieldSpec("landfill_upwind", f"Wind blowing from a landfill within {LANDFILL_KM} km (most upwind one)", agg="max", unit="%", domain=[0, 100],
                  ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="downwind", title="Downwind of landfills and industry (OSM land use × ERA5-Land wind)", level=LEVEL, fields=specs, group="Hazards",
        description=f"For each lived-in block, landfill and dump land ({LANDFILL_MIN_HA} ha or more in a block) within {LANDFILL_KM} km and industrial land (blocks {INDUSTRY_PCT}%+ "
                    f"industrial) within {INDUSTRY_KM} km, each weighted by its area, by the share of ERA5-Land daily 10 m wind "
                    "(2020-2024, speed-weighted, one rose per city) blowing from it towards the block within ±45°, and by "
                    f"1 / distance (at least {MIN_KM} km). Land use is OpenStreetMap via Overture (the landuse dataset), so "
                    "unmapped dumps are missing. Relative indices for where smoke and odour arrive most often, not concentrations.",
        source="pipeline/realestate/downwind.py (landuse cells; ECMWF ERA5-Land via Earth Engine)",
        license="ODbL 1.0 (OpenStreetMap via Overture); ERA5-Land: Copernicus licence (free with attribution)",
        default_field="landfill_smoke", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    from pipeline.realestate.powerplants import _ee
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    ee = _ee()
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = compute(r, ee)
        hit = sum(1 for x in rows.values() if x["landfill_smoke"] > 0)
        print(f"{r}: {len(rows)} blocks, {hit} downwind of a landfill within {LANDFILL_KM} km")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
