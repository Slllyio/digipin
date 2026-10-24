"""Commute length and carbon by home location: how far people travel from each neighbourhood, and what it emits.

The demand model's morning matrix (homes → jobs and activities, gravity on
free-flow arterial times, dm.matrices) spreads each ~1 km zone's trips over
destinations, here with trips inside the zone kept (INTRA_MIN, INTRA_KM). Each zone's mean motorised trip length is the trip-weighted
straight-line distance × DETOUR (INTRA_KM for trips that stay in the zone or
share its road node). Per resident per day: TRIPS_PER_CAPITA × that length ×
the model's mode mix in kg CO2 per person-km (EF_MIX). Dataset
``commute_carbon`` (L6):

    trip_km        mean motorised trip length from homes here
    co2_kg_day     transport CO2 per resident per day
    co2_t_year     … for all residents of the zone, tonnes a year

summary.json ``commute_carbon``: population-weighted trip length and CO2,
inner vs outer fifth. Mode shares are the city-wide model mix, so the map
shows the effect of distance (where people live against where activity is),
not of car ownership.

    python -m pipeline.traffic.commute_carbon --region delhi
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
DETOUR = 1.3
INTRA_KM = 0.6
INTRA_MIN = 4.0
# kg CO2 per person-km, tailpipe, Indian fleet (ICCT / ARAI factors ÷ occupancy):
# two-wheeler 0.035/1.2, car 0.14/1.6, CNG auto 0.07/2, bus 0.80/40.
MODES = {"two_wheeler": (0.40, 0.035 / 1.2), "car": (0.15, 0.14 / 1.6),
         "auto": (0.15, 0.07 / 2), "bus": (0.30, 0.80 / 40)}
EF_MIX = sum(s * ef for s, ef in MODES.values())


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def mean_trip_km(od, km):
    """Row-wise trip-weighted mean distance; rows with no trips → None. Numpy arrays. Pure."""
    import numpy as np
    tot = od.sum(axis=1)
    m = np.divide((od * km).sum(axis=1), tot, out=np.full(len(tot), np.nan), where=tot > 0)
    return m


def co2_per_resident(trip_km):
    """kg CO2 per resident per day for a mean trip length."""
    return dm.TRIPS_PER_CAPITA * trip_km * EF_MIX


# ── run ─────────────────────────────────────────────────────────────────────

def compute(region, log=print):
    import numpy as np
    feats = json.loads((REPO / "data" / "traffic" / region / "road_los.geojson").read_text())["features"]
    net = dm.Network(feats)
    zs = dm.zones(region)
    conn = dm._connect(net, zs)
    keys = list(conn)
    nodes = np.array([conn[k] for k in keys], dtype=int)
    pop = np.array([zs[k]["pop"] for k in keys]); attr = np.array([zs[k]["attr"] for k in keys])
    lon = np.array([zs[k]["lon"] for k in keys]); lat = np.array([zs[k]["lat"] for k in keys])
    kx = np.cos(np.radians(lat.mean())) * 111.32
    km = np.hypot((lon[:, None] - lon[None, :]) * kx, (lat[:, None] - lat[None, :]) * 111.32) * DETOUR
    same = nodes[:, None] == nodes[None, :]
    km = np.where(same | (km < INTRA_KM), INTRA_KM, km)
    # Unlike the assignment matrix, short trips that stay in the zone (or on its road node) count here.
    t = dm.skim(net, nodes)
    t = np.where(same, INTRA_MIN, t)
    prod = np.where(pop >= 50, pop, 0.0)
    od = dm.gravity_od(prod, attr, t, np.zeros_like(same))
    trip = mean_trip_km(od, km)
    rows = {}
    for i, k in enumerate(keys):
        if pop[i] <= 0 or not np.isfinite(trip[i]):
            continue
        c = co2_per_resident(trip[i])
        rows[k] = {"trip_km": round(float(trip[i]), 2), "co2_kg_day": round(float(c), 3),
                   "co2_t_year": round(float(c * pop[i] * 365 / 1000), 1)}
    ok = [i for i, k in enumerate(keys) if k in rows]
    p = pop[ok]; t = trip[ok]
    w = p / (p.sum() or 1)
    order = np.argsort(t)
    cum = np.cumsum(p[order]) / (p.sum() or 1)
    inner = order[cum <= 0.2]; outer = order[cum >= 0.8]
    mean_km = float((t * w).sum())
    summ = {"zones": len(rows), "pop_mean_trip_km": round(mean_km, 2),
            "co2_kg_resident_day": round(co2_per_resident(mean_km), 3),
            "co2_kt_year": round(sum(r["co2_t_year"] for r in rows.values()) / 1000, 1),
            "inner_fifth_trip_km": round(float(np.average(t[inner], weights=p[inner])), 2) if len(inner) else None,
            "outer_fifth_trip_km": round(float(np.average(t[outer], weights=p[outer])), 2) if len(outer) else None,
            "assumptions": {"detour": DETOUR, "intra_km": INTRA_KM, "kg_co2_per_pkm_mix": round(EF_MIX, 4),
                            "modes": {m: {"share": s, "kg_per_pkm": round(ef, 4)} for m, (s, ef) in MODES.items()}}}
    log(f"{region}: {json.dumps({k: v for k, v in summ.items() if k != 'assumptions'})}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("trip_km", "Mean motorised trip length from homes here", agg="mean", unit="km", domain=[0, 20],
                  ramp="heat", higher_is="worse"),
        FieldSpec("co2_kg_day", "Transport CO2 per resident per day", agg="mean", unit="kg", ramp="heat",
                  higher_is="worse"),
        FieldSpec("co2_t_year", "Transport CO2 of all residents", agg="sum", unit="t/year", ramp="reds",
                  higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="commute_carbon", title="Commute length and carbon", level=dm.ZONE_LEVEL, fields=specs,
        group="Traffic & mobility",
        description="Mean motorised trip length from each ~1 km home zone in the demand model's morning matrix "
                    f"(gravity on arterial times, straight line × {DETOUR}), and tailpipe CO2 per resident at the "
                    f"model's city-wide mode mix ({EF_MIX:.3f} kg per person-km: two-wheelers, cars, autos, buses). "
                    "Shows the cost of distance between homes and activity, not of car ownership.",
        source="pipeline/traffic/commute_carbon.py over the demand model",
        license="ODbL (OpenStreetMap) + CC BY 4.0 (GHSL) + CDLA-Permissive-2.0 (Overture)",
        default_field="trip_km", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, dm.ZONE_LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    if not (REPO / "data" / "traffic" / region / "road_los.geojson").exists():
        log(f"{region}: no road_los.geojson, skipped")
        return None
    rows, summ = compute(region, log)
    res = cell_dataset(region, rows)
    sp = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(sp.read_text()) if sp.exists() else {}
    s["commute_carbon"] = summ
    sp.write_text(json.dumps(s, indent=2) + "\n")
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
