"""Chennai's piped-water storage near each block: Metrowater's tank and filling-post asset maps (via OpenCity, public domain).

CMWSSB (Chennai Metrowater) publishes its water distribution station assets as KML on OpenCity: overhead tanks and
underground reservoirs with their capacity in million litres, and the filling posts where water lorries load. Per
lived-in L7 block in Chennai (dataset ``water_storage``):

    ws_tank_km        distance to the nearest overhead or underground tank
    ws_ml_2km         tank capacity within 2 km (million litres)
    ws_l_per_res      that capacity per resident living within 2 km of the block (litres)
    ws_tanks_2km      tanks within 2 km
    ws_fill_km        distance to the nearest lorry filling post;  ws_fills_2km  filling posts within 2 km

Tanks are polygons; their centroid is used. A tank with no capacity listed counts as a tank but adds no litres; a
capacity over 1,000 ML is read as litres.

    python -m pipeline.realestate.waterstorage
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NEAR_KM = 2.0
B = "https://data.opencity.in/dataset/8ddf7fda-3530-4003-9376-47ed75f3b7b1/resource/"
FILES = {
    "oht": (B + "317bd2e9-7fec-4801-878f-51f4100e0ab7/download/d062444d-11e3-4841-94af-65c53a2a7f36.kml", "capacity_of_oht_ml"),
    "ugt": (B + "60d18a80-e20d-4db1-99a1-3a12d03cba25/download/9c7ff5bd-c5ad-414b-a109-f495c6fa8066.kml", "capacity_of_ugt_ml"),
    "fill": (B + "684cd178-233d-4865-8653-ffd5d1575d0c/download/ccb3a258-f23f-4ecd-92f1-f2b7de688b61.kml", None),
}


def _f(x):
    try:
        v = float(str(x).strip())
        return v if v > 0 else None
    except ValueError:
        return None


def points(text, cap_key):
    """[(lat, lng, capacity ML or None)] from a KML of points or polygons (polygon: mean of its ring)."""
    import xml.etree.ElementTree as ET
    tag = lambda e: e.tag.rsplit("}", 1)[-1]
    out = []
    for pm in (e for e in ET.fromstring(text).iter() if tag(e) == "Placemark"):
        d = {x.get("name"): (x.text or "").strip() for x in pm.iter() if tag(x) == "SimpleData"}
        co = next((x.text for x in pm.iter() if tag(x) == "coordinates" and x.text), None)
        if not co:
            continue
        xy = [tuple(map(float, p.split(",")[:2])) for p in co.split()]
        if len(xy) > 1 and xy[0] == xy[-1]:
            xy = xy[:-1]
        lng, lat = sum(p[0] for p in xy) / len(xy), sum(p[1] for p in xy) / len(xy)
        cap = _f(d.get(cap_key)) if cap_key else None
        if cap and cap > 1000:   # entered in litres (one overhead tank reads 60,000 "ML")
            cap /= 1e6
        out.append((lat, lng, cap))
    return out


def block_rows(cells, pops, tanks, fills, near_km=NEAR_KM):
    """{code: fields}; ``pops`` gives each block's residents (same order as ``cells``)."""
    import numpy as np
    if not cells or not tanks:
        return {}
    lat0 = sum(c[1] for c in cells) / len(cells)
    kx = 111.32 * math.cos(math.radians(lat0))
    xy = lambda pts: np.array([(p[0] * 110.57, p[1] * kx) for p in pts]).reshape(-1, 2)
    C, T, F = xy([(c[1], c[2]) for c in cells]), xy(tanks), xy(fills)
    cap = np.array([t[2] or 0.0 for t in tanks])
    pop = np.asarray(pops, dtype=float)
    rows = {}
    for k, (code, _, _) in enumerate(cells):
        dt = np.hypot(T[:, 0] - C[k, 0], T[:, 1] - C[k, 1])
        near = dt <= near_km
        ml = float(cap[near].sum())
        res = float(pop[np.hypot(C[:, 0] - C[k, 0], C[:, 1] - C[k, 1]) <= near_km].sum())
        r = {"ws_tank_km": round(float(dt.min()), 2), "ws_ml_2km": round(ml, 2), "ws_tanks_2km": int(near.sum())}
        if res > 0:
            r["ws_l_per_res"] = round(1e6 * ml / res, 1)
        if len(F):
            df = np.hypot(F[:, 0] - C[k, 0], F[:, 1] - C[k, 1])
            r.update(ws_fill_km=round(float(df.min()), 2), ws_fills_2km=int((df <= near_km).sum()))
        rows[code] = r
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("ws_tank_km", "Distance to the nearest Metrowater storage tank", agg="mean", unit="km", domain=[0, 5], ramp="reds", higher_is="worse"),
        FieldSpec("ws_ml_2km", "Metrowater tank capacity within 2 km", agg="mean", unit="million litres", domain=[0, 20], ramp="viridis", higher_is="better"),
        FieldSpec("ws_l_per_res", "Tank capacity within 2 km per resident within 2 km", agg="mean", unit="litres", domain=[0, 60], ramp="viridis", higher_is="better"),
        FieldSpec("ws_tanks_2km", "Metrowater storage tanks within 2 km", agg="mean", unit="tanks", ramp="viridis", higher_is="better"),
        FieldSpec("ws_fill_km", "Distance to the nearest water-lorry filling post", agg="mean", unit="km", domain=[0, 8], ramp="viridis", higher_is=None),
        FieldSpec("ws_fills_2km", "Water-lorry filling posts within 2 km", agg="mean", unit="posts", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="water_storage", title="Piped-water storage tanks (Chennai Metrowater)", level=LEVEL, fields=specs, group="Environment",
        description="Distance to Chennai Metrowater's nearest overhead or underground storage tank, the tank capacity within 2 km "
                    "and per resident, and the lorry filling posts nearby, from CMWSSB's water distribution station asset maps "
                    "on data.opencity.in.",
        source="pipeline/realestate/waterstorage.py (CMWSSB water distribution station assets via OpenCity)",
        license="Public domain (CMWSSB via data.opencity.in)", default_field="ws_l_per_res", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests
    from pipeline.realestate.assembly import _column
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="chennai")
    region = ap.parse_args(argv).region
    got = {k: points(requests.get(u, timeout=300).content.decode("utf-8-sig"), cap) for k, (u, cap) in FILES.items()}
    cells = lived_cells(region)
    codes, (pop,) = _column(region, "population", "population")
    pm = dict(zip(codes, pop))
    rows = block_rows(cells, [pm.get(c[0]) or 0 for c in cells], got["oht"] + got["ugt"], got["fill"])
    cell_dataset(region, rows)
    v = sorted(r.get("ws_l_per_res", 0) for r in rows.values())
    print(f"{region}: {len(got['oht'])} overhead + {len(got['ugt'])} underground tanks "
          f"({sum(t[2] or 0 for t in got['oht'] + got['ugt']):.0f} ML), {len(got['fill'])} filling posts; {len(rows)} blocks, "
          f"median {v[len(v) // 2]} L per resident within 2 km, {sum(1 for r in rows.values() if r['ws_tank_km'] > 3)} blocks over 3 km from a tank")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
