"""Brick kilns upwind of each block (IGP asset-level brick kiln inventory × ERA5-Land wind).

Per L7 lived-in block (dataset ``brick_kilns``):

    kilns_10km      brick kilns within 10 km
    kiln_pm25_25km  their estimated PM2.5 emissions within KILN_KM (tonnes a year, coal-fired emission factors)
    kiln_km         distance to the nearest kiln (up to KILN_KM)
    kiln_smoke      upwind kiln index: sum over kilns within KILN_KM of PM2.5 (t/yr) × the share of the wind
                    (daily means by speed, 2020-2024) blowing from the kiln towards the block (±45°) ÷ distance
                    (km, at least 1). A relative index, not a concentration.

Kilns come from the asset-level emissions inventory of the Indo-Gangetic Plain (Brick_Kilns_IND_coal.csv on the
public S3 bucket assetdata-igp, CC BY 4.0): 22,459 fixed-chimney and zigzag kilns across UP, Bihar, West Bengal,
Haryana, Punjab, Rajasthan, Uttarakhand and Delhi, mapped from satellite imagery. Only Delhi, Lucknow and Kolkata
have kilns within reach; other cities get no rows. Kilns fire in the dry season (roughly November to June), while the
wind rose here is the whole year.

    python -m pipeline.realestate.kilns --region all
"""
from __future__ import annotations

import argparse
import csv
import io
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = "https://assetdata-igp.s3-ap-southeast-1.amazonaws.com/asset_igp_csvs/Brick_Kilns_IND_coal.csv"
KILN_KM = 25
NEAR_KM = 10
MIN_KM = 1.0


def parse(text):
    """[(lat, lng, pm25_t_yr, type)] from the inventory CSV."""
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            out.append((float(r["lat"]), float(r["lon"]), float(r["pm25_t_yr"] or 0), r.get("type") or ""))
        except (KeyError, ValueError):
            continue
    return out


def fetch_kilns():
    import requests
    r = requests.get(URL, timeout=120)
    r.raise_for_status()
    return parse(r.content.decode("utf-8-sig"))


def exposure(cells, kilns, table, lat0):
    """{code: row} for cells [(code, lat, lng)] and kilns [(lat, lng, pm25, type)] with a 5° wind-share table."""
    import numpy as np

    from pipeline.realestate.downwind import BINS
    if not kilns or not cells:
        return {}
    kx = 111.32 * math.cos(math.radians(lat0))
    ty = np.array([c[1] for c in cells]) * 110.57
    tx = np.array([c[2] for c in cells]) * kx
    n = len(cells)
    near10, pm, smoke = np.zeros(n), np.zeros(n), np.zeros(n)
    best = np.full(n, np.inf)
    for ky, kx_, t, _ in kilns:
        dy, dx = ty - ky * 110.57, tx - kx_ * kx
        d = np.hypot(dx, dy)
        m = d <= KILN_KM
        if not m.any():
            continue
        best = np.where(m, np.minimum(best, d), best)
        near10 += d <= NEAR_KM
        pm[m] += t
        brg = (np.degrees(np.arctan2(dx[m], dy[m])) + 360) % 360
        share = table[np.round(brg / (360 / BINS)).astype(int) % BINS]
        smoke[m] += t * share / np.maximum(d[m], MIN_KM)
    return {c[0]: {"kilns_10km": int(near10[j]), "kiln_pm25_25km": round(float(pm[j]), 1),
                   "kiln_km": round(float(best[j]), 1) if np.isfinite(best[j]) else None, "kiln_smoke": round(float(smoke[j]), 2)}
            for j, c in enumerate(cells) if np.isfinite(best[j])}


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("kilns_10km", f"Brick kilns within {NEAR_KM} km", agg="max", unit="kilns", ramp="reds", higher_is="worse"),
        FieldSpec("kiln_pm25_25km", f"Brick-kiln PM2.5 emitted within {KILN_KM} km", agg="max", unit="t/yr", ramp="reds", higher_is="worse"),
        FieldSpec("kiln_km", "Nearest brick kiln", agg="min", unit="km", ramp="reds", higher_is="better"),
        FieldSpec("kiln_smoke", "Upwind brick-kiln index (t PM2.5 × downwind wind share ÷ km)", agg="max", unit="index", ramp="reds",
                  higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="brick_kilns", title="Brick kilns upwind (IGP kiln inventory, ERA5-Land)", level=LEVEL, fields=specs, group="Hazards",
        description=f"Brick kilns from the asset-level emissions inventory of the Indo-Gangetic Plain (22,459 Indian kilns mapped from "
                    f"satellite imagery, with coal-fired PM2.5 emission estimates; CSV on the public S3 bucket assetdata-igp) within "
                    f"{KILN_KM} km of each block, and an upwind index weighting each kiln's PM2.5 by the share of ERA5-Land daily "
                    "10 m wind (2020-2024, one rose per city) blowing from it towards the block within ±45°, divided by distance. "
                    "Covers the Gangetic plain only (Delhi, Lucknow, Kolkata here). Kilns fire November to June; the rose is annual. "
                    "A relative index, not a concentration.",
        source="pipeline/realestate/kilns.py (IGP asset-level brick kiln inventory; ECMWF ERA5-Land via Earth Engine)",
        license="CC BY 4.0 (IGP asset-level emissions data); ERA5-Land: Copernicus licence (free with attribution)",
        default_field="kiln_smoke", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS, bbox_for
    from pipeline.realestate.downwind import sector_table
    from pipeline.realestate.powerplants import _ee, fetch_wind, lived_cells, rose
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    kilns = fetch_kilns()
    ee = None
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        w, s, e, n = bbox_for(r)
        pad = KILN_KM / 100
        near = [k for k in kilns if s - pad <= k[0] <= n + pad and w - pad <= k[1] <= e + pad]
        if not near:
            print(f"{r}: no kilns within {KILN_KM} km")
            continue
        ee = ee or _ee()
        table = sector_table(rose(fetch_wind(ee, (s + n) / 2, (w + e) / 2)))
        rows = exposure(lived_cells(r), near, table, (s + n) / 2)
        print(f"{r}: {len(near)} kilns near, {len(rows)} blocks within {KILN_KM} km, "
              f"{sum(1 for x in rows.values() if x['kilns_10km'])} with a kiln within {NEAR_KM} km")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
