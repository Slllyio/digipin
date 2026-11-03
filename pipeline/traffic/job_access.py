"""Jobs and activities reachable in 45 minutes: by car at 9 am versus by train and walking.

Cumulative-opportunity accessibility (Hansen 1959; Geurs & van Wee 2004)
over the demand model's ~1 km zones (dm.zones): the "jobs" are the same
activity floor space the model sends commuters to (GHSL non-residential
built-up + OSM amenities), so each zone's score is the share of the city's
activity reachable within THRESHOLD_MIN.

    car      zone access (straight line × 1.3 at 15 km/h to the nearest
             arterial node) + 09:00 congested arterial time (BPR on the
             demand model's vc_am) + egress
    transit  walk (straight line × 1.3 at 4.8 km/h) to the nearest metro or
             rail station within WALK_MAX_MIN, WAIT_MIN, ride at RIDE_KMH over
             the straight line × 1.25 to the station nearest the
             destination, walk out; or walk all the way if that is quicker.
             Every station is assumed to connect to every other (lines and
             interchanges are not modelled), so this is an upper bound for
             rail and ignores buses (no open timetables except Bengaluru).

Dataset ``job_access`` (L6): jobs_car_pct, jobs_transit_pct, transit_car_ratio.
summary.json ``job_access``: population-weighted means.

    python -m pipeline.traffic.job_access --region delhi
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS
from pipeline.traffic import demand_model as dm
from pipeline.traffic.emergency_access import access_min, period_time

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
VECTORS = REPO / "data" / "vectors"
THRESHOLD_MIN = 45.0
WALK_M_MIN = 80.0
DETOUR = 1.3
WALK_MAX_MIN = 20.0
WAIT_MIN = 5.0
RIDE_KMH = 33.0              # Delhi Metro scheduled average incl. dwell ≈ 32–35 km/h
RIDE_DETOUR = 1.25
CHUNK = 256


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def transit_times(zx, zy, sx, sy):
    """Zone × zone minutes by walk + train (or walking only). Numpy arrays of lon/lat. Pure."""
    import numpy as np
    k = np.cos(np.radians(np.mean(zy))) if len(zy) else 1.0

    def dist(ax, ay, bx, by):
        return np.hypot((ax[:, None] - bx[None, :]) * k * 111320, (ay[:, None] - by[None, :]) * 111320)

    walk_all = dist(zx, zy, zx, zy) * DETOUR / WALK_M_MIN
    if not len(sx):
        return walk_all
    zs = dist(zx, zy, sx, sy)
    near = zs.argmin(1)
    w = zs[np.arange(len(zx)), near] * DETOUR / WALK_M_MIN
    ok = w <= WALK_MAX_MIN
    ss = dist(sx, sy, sx, sy) * RIDE_DETOUR / 1000 / RIDE_KMH * 60
    ride = ss[near][:, near]
    t = w[:, None] + WAIT_MIN + ride + w[None, :]
    t[~ok, :] = np.inf
    t[:, ~ok] = np.inf
    return np.minimum(walk_all, t)


def reach_share(times, attr, limit=THRESHOLD_MIN):
    """Share (%) of total ``attr`` reachable within ``limit`` from each row. Pure."""
    import numpy as np
    a = np.asarray(attr, dtype=float)
    tot = a.sum() or 1.0
    return 100.0 * ((times <= limit) * a[None, :]).sum(1) / tot


# ── run ─────────────────────────────────────────────────────────────────────

def compute(region, log=print):
    import numpy as np
    from scipy.sparse.csgraph import dijkstra
    feats = json.loads((REPO / "data" / "traffic" / region / "road_los.geojson").read_text())["features"]
    net = dm.Network(feats)
    zs = dm.zones(region)
    keys = [k for k, z in zs.items() if z["pop"] > 0 or z["attr"] > 0]
    zx = np.array([zs[k]["lon"] for k in keys]); zy = np.array([zs[k]["lat"] for k in keys])
    attr = np.array([zs[k]["attr"] for k in keys]); pop = np.array([zs[k]["pop"] for k in keys])
    # Car: congested 09:00 link times.
    times = [period_time(net.t0[e], float(feats[net.feat[e]]["properties"].get("vc_am") or 0.0)) for e in range(len(net.head))]
    g, _ = dm._graph(net, times)
    node = np.full(len(keys), -1)
    acc = np.full(len(keys), np.inf)
    for i, k in enumerate(keys):
        nd, d = net.nearest_node(zs[k]["lon"], zs[k]["lat"])
        if nd >= 0 and d <= 3000:
            node[i], acc[i] = nd, access_min(d)
    have = node >= 0
    car = np.zeros(len(keys))
    idx = np.where(have)[0]
    for c0 in range(0, len(idx), CHUNK):
        rows = idx[c0:c0 + CHUNK]
        d = dijkstra(g, indices=node[rows], limit=THRESHOLD_MIN)
        t = acc[rows][:, None] + d[:, node[idx]] + acc[idx][None, :]
        full = np.full((len(rows), len(keys)), np.inf)
        full[:, idx] = t
        car[rows] = reach_share(full, attr)
    log(f"{region}: car done for {len(idx)} zones")
    st = []
    p = VECTORS / f"rail_stations_{region}.geojson"
    if p.exists():
        st = [f["geometry"]["coordinates"] for f in json.loads(p.read_text())["features"]]
    sx = np.array([s[0] for s in st]); sy = np.array([s[1] for s in st])
    transit = np.zeros(len(keys))
    for c0 in range(0, len(keys), 1024):
        sl = slice(c0, c0 + 1024)
        # Rows for this slice against every zone.
        t = _rows_transit(zx, zy, sx, sy, sl)
        transit[sl] = reach_share(t, attr)
    rows = {}
    for i, k in enumerate(keys):
        if pop[i] <= 0:
            continue
        r = {"jobs_transit_pct": round(float(transit[i]), 1)}
        if have[i]:
            r["jobs_car_pct"] = round(float(car[i]), 1)
            if car[i] > 0:
                r["transit_car_ratio"] = round(float(transit[i] / car[i]), 2)
        rows[k] = r
    w = pop / (pop.sum() or 1)
    summ = {"zones": len(rows), "pop_mean_jobs_car_pct": round(float((car * w).sum()), 1),
            "pop_mean_jobs_transit_pct": round(float((transit * w).sum()), 1), "stations": len(st),
            "threshold_min": THRESHOLD_MIN,
            "assumptions": {"wait_min": WAIT_MIN, "ride_kmh": RIDE_KMH, "walk_max_min": WALK_MAX_MIN,
                            "all_stations_connected": True}}
    log(f"{region}: {json.dumps(summ)}")
    return rows, summ


def _rows_transit(zx, zy, sx, sy, sl):
    """transit_times for the rows in ``sl`` against all zones (keeps memory to a slice)."""
    import numpy as np
    full = transit_times(np.concatenate([zx[sl], zx]), np.concatenate([zy[sl], zy]), sx, sy)
    n = len(zx[sl])
    return full[:n, n:]


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("jobs_car_pct", f"City jobs and activities within {int(THRESHOLD_MIN)} min by car at 9 am",
                  agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is="better"),
        FieldSpec("jobs_transit_pct", f"… within {int(THRESHOLD_MIN)} min by train and walking",
                  agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is="better"),
        FieldSpec("transit_car_ratio", "Train-and-walk reach as a share of car reach", agg="mean", unit="ratio",
                  domain=[0, 1], ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="job_access", title="Jobs within 45 minutes", level=dm.ZONE_LEVEL, fields=specs, group="Traffic & mobility",
        description="Share of the city's jobs and activities (demand model activity floor space) reachable within "
                    f"{int(THRESHOLD_MIN)} minutes: by car on the 9 am congested arterials, and by walking plus "
                    f"metro/rail ({int(WAIT_MIN)} min wait, {int(RIDE_KMH)} km/h, every station assumed connected; "
                    "no buses). Cumulative-opportunity accessibility.",
        source="pipeline/traffic/job_access.py over the demand model, road_los and rail_stations",
        license="ODbL (OpenStreetMap) + CC BY 4.0 (GHSL) + CDLA-Permissive-2.0 (Overture)",
        default_field="jobs_transit_pct", extrude=False)
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
    s["job_access"] = summ
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
