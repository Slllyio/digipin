"""Cyclone winds per block from 44 seasons of best tracks (IBTrACS, North Indian basin).

Per L7 lived-in block (dataset ``cyclones``):

    wind_max_kmh    strongest modelled sustained wind of 1981-2024 at the block
    wind_rl50_kmh   50-year return level of the sustained wind (Gumbel on yearly maxima, mixed with the
                    share of years with any storm wind)
    gale_years      seasons in which the block saw gale-force wind (62 km/h, a cyclonic storm) or more
    storms_200km    storms of cyclonic-storm strength or more whose centre passed within 200 km

Each track (JTWC 1-minute winds where given, else IMD 3-minute winds scaled to 1-minute) is interpolated to
30-minute steps and turned into a wind field with a modified Rankine vortex: rising linearly to the maximum at
the radius of maximum wind (JTWC radius, else Willoughby et al. 2006) and falling as (R/r)^0.5 beyond it. Over
land the best-track intensity already decays, so no separate inland decay is applied; asymmetry from the storm's
forward motion and local terrain are left out, so treat block values as a smooth regional field.

    python -m pipeline.realestate.cyclones --region all
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = ("https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/"
       "v04r01/access/csv/ibtracs.NI.list.v04r01.csv")
FIRST, LAST = 1981, 2024
KT = 1.852
GALE_KMH = 62
NEAR_KM = 200
REACH_KM = 500
STEP_H = 0.5
SHAPE_X = 0.5
IMD_TO_1MIN = 1 / 0.93        # 3-minute (IMD) to 1-minute (JTWC) sustained wind, WMO at-sea conversion
RETURN_T = 50


def _f(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def rmw_km(vmax_kmh, lat):
    """Radius of maximum wind, km (Willoughby, Darling and Rahn 2006, eq. 7a)."""
    return 46.4 * math.exp(-0.0155 * vmax_kmh / 3.6 + 0.0169 * abs(lat))


def wind_at(r_km, vmax, rmw):
    """Modified Rankine vortex: sustained wind at r_km from the centre."""
    if r_km <= rmw:
        return vmax * r_km / rmw
    return vmax * (rmw / r_km) ** SHAPE_X


def haversine_km(lat1, lng1, lat2, lng2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lng2 - lng1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


def parse(text):
    """{sid: (season, [(t_hours, lat, lng, vmax_kmh, rmw_km)])} from the IBTrACS CSV."""
    tracks = defaultdict(list)
    seasons = {}
    rows = csv.DictReader(io.StringIO(text))
    for r in rows:
        season = _f(r.get("SEASON"))
        if season is None or not FIRST <= season <= LAST:
            continue
        lat, lng = _f(r.get("LAT")), _f(r.get("LON"))
        v = _f(r.get("USA_WIND"))
        if v is None:
            imd = _f(r.get("NEWDELHI_WIND"))
            v = imd * IMD_TO_1MIN if imd is not None else None
        if lat is None or lng is None or v is None or v <= 0:
            continue
        t = datetime.strptime(r["ISO_TIME"], "%Y-%m-%d %H:%M:%S").timestamp() / 3600
        vk = v * KT
        rm = _f(r.get("USA_RMW"))
        tracks[r["SID"]].append((t, lat, lng, vk, rm * KT if rm and rm > 0 else rmw_km(vk, lat)))
        seasons[r["SID"]] = int(season)
    return {sid: (seasons[sid], sorted(pts)) for sid, pts in tracks.items()}


def densify(pts):
    """Linear interpolation of a track to STEP_H steps (gaps over 6 h are not bridged)."""
    out = []
    for a, b in zip(pts, pts[1:]):
        dt = b[0] - a[0]
        if dt <= 0:
            continue
        n = max(1, round(dt / STEP_H)) if dt <= 6 else 1
        for k in range(n):
            f = k / n
            out.append(tuple(a[i] + f * (b[i] - a[i]) for i in range(5)))
    if pts:
        out.append(pts[-1])
    return out


def gumbel_rl(maxima, years, T=RETURN_T):
    """T-year return level from yearly maxima (zeros for quiet years): Gumbel by moments on the non-zero years,
    mixed with their share p of all years, so F(x) = 1 - 1/(T p). None with fewer than 5 non-zero years."""
    nz = [m for m in maxima if m > 0]
    if len(nz) < 5:
        return None
    p = len(nz) / years
    if T * p <= 1:
        return 0.0
    mean = sum(nz) / len(nz)
    sd = math.sqrt(sum((m - mean) ** 2 for m in nz) / (len(nz) - 1))
    beta = sd * math.sqrt(6) / math.pi
    mu = mean - 0.5772 * beta
    return mu - beta * math.log(-math.log(1 - 1 / (T * p)))


def winds(cells, tracks):
    """{code: row} for cells [(code, lat, lng)]: per-season maxima folded into the four fields."""
    import numpy as np
    codes = [c for c, _, _ in cells]
    lat = np.array([y for _, y, _ in cells])
    lng = np.array([x for _, _, x in cells])
    clat, clng = float(lat.mean()), float(lng.mean())
    years = LAST - FIRST + 1
    yearly = np.zeros((years, len(codes)))
    near = np.zeros(len(codes))
    p = math.pi / 180
    for season, pts in tracks.values():
        dense = [q for q in densify(pts) if haversine_km(q[1], q[2], clat, clng) <= REACH_KM]
        if not dense:
            continue
        storm = np.zeros(len(codes))
        passed = np.zeros(len(codes), dtype=bool)
        for _, y, x, vmax, rm in dense:
            a = np.sin((lat - y) * p / 2) ** 2 + np.cos(lat * p) * math.cos(y * p) * np.sin((lng - x) * p / 2) ** 2
            r = 12742 * np.arcsin(np.sqrt(a))
            v = np.where(r <= rm, vmax * r / rm, vmax * (rm / np.maximum(r, 1e-6)) ** SHAPE_X)
            storm = np.maximum(storm, v)
            if vmax >= GALE_KMH:
                passed |= r <= NEAR_KM
        yearly[season - FIRST] = np.maximum(yearly[season - FIRST], storm)
        near += passed
    rows = {}
    for j, code in enumerate(codes):
        col = yearly[:, j]
        rl = gumbel_rl(col.tolist(), years)
        rows[code] = {"wind_max_kmh": round(float(col.max()), 1), "wind_rl50_kmh": round(rl, 1) if rl is not None else None,
                      "gale_years": int((col >= GALE_KMH).sum()), "storms_200km": int(near[j])}
    return rows


def lived_cells(region):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    pop = next(d for d in cat["datasets"] if d["id"] == "population")
    entry = next(r for r in pop["regions"] if r["name"] == region)
    out = []
    for c in store.read_region(CELLS, entry).codes:
        b = store.cell_bounds(c)
        out.append((c, (b["south"] + b["north"]) / 2, (b["west"] + b["east"]) / 2))
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("wind_max_kmh", f"Strongest cyclone wind {FIRST}-{LAST} (modelled, sustained)", agg="max", unit="km/h", ramp="reds", higher_is="worse"),
        FieldSpec("wind_rl50_kmh", "50-year cyclone wind (sustained)", agg="max", unit="km/h", ramp="reds", higher_is="worse"),
        FieldSpec("gale_years", f"Seasons with gale-force cyclone wind ({GALE_KMH} km/h+)", agg="max", unit="seasons", ramp="reds", higher_is="worse"),
        FieldSpec("storms_200km", f"Cyclonic storms passing within {NEAR_KM} km", agg="max", unit="storms", ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="cyclones", title="Cyclone winds (IBTrACS)", level=LEVEL, fields=specs, group="Hazards",
        description=f"Best tracks of North Indian Ocean cyclones {FIRST}-{LAST} (IBTrACS v04r01; JTWC 1-minute winds, else IMD "
                    "3-minute winds scaled to 1-minute) turned into a wind field per block with a modified Rankine vortex "
                    "(radius of maximum wind from JTWC or Willoughby et al. 2006). Strongest wind, 50-year return level "
                    "(Gumbel on yearly maxima), seasons with gale-force wind and storms passing within 200 km. A smooth "
                    "regional field: no forward-motion asymmetry, terrain or building effects.",
        source="pipeline/realestate/cyclones.py (NOAA NCEI IBTrACS)",
        license="Public domain (NOAA NCEI IBTrACS; cite Knapp et al. 2010)", default_field="wind_rl50_kmh", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    ap.add_argument("--csv", help="a local copy of the IBTrACS NI CSV")
    a = ap.parse_args(argv)
    text = Path(a.csv).read_text() if a.csv else urllib.request.urlopen(URL, timeout=300).read().decode()
    tracks = parse(text)
    print(f"{len(tracks)} storms {FIRST}-{LAST}")
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        rows = winds(lived_cells(r), tracks)
        mx = max((x["wind_rl50_kmh"] or 0) for x in rows.values()) if rows else 0
        print(f"{r}: {len(rows)} blocks, 50-year wind up to {mx:.0f} km/h")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
