"""Add GTFS transit-access signals to the traffic grid.

Public-transit access is the multimodal half of "traffic": cells well served by
frequent buses generate and absorb trips without adding road congestion. This
parses a standard GTFS feed (the open timetable format most Indian city-bus
operators publish, e.g. via Transitland / data.gov.in) and bins per-cell:

  * transit_stops      — number of stops in the cell
  * transit_routes     — distinct routes serving those stops
  * transit_headway_min— median headway (minutes between departures) at the
                         busiest stop (lower = more frequent = better access)
  * transit_access     — 0..100 access score (frequency x route breadth)

It merges these arrays into the existing `traffic_grid.json` (same grid), so the
browser samples one file. The GTFS source is pluggable (`--gtfs <dir|zip|url>`)
and the step **degrades gracefully**: if no feed is supplied/available the grid
is left unchanged and the browser simply shows no transit signal.

`stop_frequencies` and `access_score` are pure (stdlib) and unit-tested; reading
the zip/csv + grid merge is thin IO.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import statistics
import zipfile
from pathlib import Path

from pipeline._lib.regions import get_default_region_name

log = logging.getLogger("pipeline.traffic.gtfs_transit")


# ───────────────────────── pure helpers ─────────────────────────
def _to_minutes(hms):
    """'HH:MM:SS' (GTFS allows >24h) → minutes-since-midnight, or None."""
    try:
        h, m, s = (int(x) for x in hms.split(":"))
        return h * 60 + m + s / 60.0
    except Exception:
        return None


def stop_frequencies(stop_times):
    """Median headway (min) per stop from stop_times rows. Pure.

    stop_times: iterable of {stop_id, departure_time}. For each stop, sort
    departures and take the median gap; a single departure → None (unknown)."""
    by_stop = {}
    for r in stop_times:
        t = _to_minutes(r.get("departure_time", "") or r.get("arrival_time", ""))
        if t is None:
            continue
        by_stop.setdefault(r.get("stop_id"), []).append(t)
    out = {}
    for sid, times in by_stop.items():
        times.sort()
        gaps = [b - a for a, b in zip(times, times[1:]) if b - a > 0]
        out[sid] = round(statistics.median(gaps), 1) if gaps else None
    return out


def access_score(headway_min, route_count):
    """0..100 transit-access score from headway + route breadth. Pure.

    Frequency dominates: a 5-min headway ≈ excellent, ≥30-min ≈ poor. Route
    breadth adds a modest bonus. None headway (≤1 departure) → low score."""
    if headway_min is None:
        freq = 10.0
    else:
        # 5 min → 100, 30 min → ~0 (linear, clamped)
        freq = max(0.0, min(100.0, 100.0 - (headway_min - 5) * (100.0 / 25.0)))
    breadth = min(20.0, (route_count or 0) * 5.0)   # up to +20 for 4+ routes
    return int(round(min(100.0, freq * 0.8 + breadth)))


# ───────────────────────── GTFS IO ─────────────────────────
def _open_table(src, name):
    """Yield dict rows from <name>.txt inside a GTFS dir or zip. Empty if absent."""
    p = Path(src)
    if p.is_dir():
        f = p / name
        if not f.exists():
            return
        with f.open(encoding="utf-8-sig", newline="") as fh:
            yield from csv.DictReader(fh)
    elif zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            if name not in z.namelist():
                return
            with z.open(name) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                yield from csv.DictReader(text)


def _cell_of(lng, lat, grid):
    b = grid["bounds"]
    w, s, e, n = b["west"], b["south"], b["east"], b["north"]
    if not (w <= lng < e and s <= lat < n):
        return -1
    nx, ny = grid["nx"], grid["ny"]
    x = min(nx - 1, int((lng - w) / (e - w) * nx))
    y = min(ny - 1, int((n - lat) / (n - s) * ny))
    return y * nx + x


def merge_into_grid(grid, src):
    """Read a GTFS feed and add transit_* arrays to `grid` in place. Returns grid."""
    stops = list(_open_table(src, "stops.txt"))
    if not stops:
        log.warning("no stops.txt in %s — leaving grid unchanged", src)
        return grid
    headways = stop_frequencies(_open_table(src, "stop_times.txt"))

    # routes per stop via trips→stop_times is heavy; approximate route breadth by
    # distinct trip_id count at each stop (a reasonable proxy when routes.txt
    # linkage is absent). Cheap single pass.
    trips_per_stop = {}
    for r in _open_table(src, "stop_times.txt"):
        trips_per_stop.setdefault(r.get("stop_id"), set()).add(r.get("trip_id"))

    size = grid["nx"] * grid["ny"]
    t_stops = [0] * size
    t_routes = [0] * size
    t_head = [None] * size

    for st in stops:
        try:
            lat, lng = float(st["stop_lat"]), float(st["stop_lon"])
        except (KeyError, ValueError, TypeError):
            continue
        idx = _cell_of(lng, lat, grid)
        if idx < 0:
            continue
        t_stops[idx] += 1
        sid = st.get("stop_id")
        t_routes[idx] = max(t_routes[idx], len(trips_per_stop.get(sid, ())))
        hw = headways.get(sid)
        if hw is not None and (t_head[idx] is None or hw < t_head[idx]):
            t_head[idx] = hw

    grid["transit_stops"] = t_stops
    grid["transit_routes"] = t_routes
    grid["transit_headway_min"] = t_head
    grid["transit_access"] = [
        access_score(t_head[i], t_routes[i]) if t_stops[i] else 0 for i in range(size)
    ]
    log.info("merged transit: %d stops over %d cells", sum(t_stops),
             sum(1 for c in t_stops if c))
    return grid


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--gtfs", required=True, help="GTFS dir or .zip")
    ap.add_argument("--grid", default=None, help="traffic_grid.json to enrich")
    args = ap.parse_args()

    region = get_default_region_name()
    grid_path = Path(args.grid) if args.grid else Path(f"data/traffic/{region}/traffic_grid.json")
    if not grid_path.exists():
        raise SystemExit(f"missing {grid_path} — run pipeline.traffic.traffic_grid first")
    grid = json.loads(grid_path.read_text())
    merge_into_grid(grid, args.gtfs)
    grid_path.write_text(json.dumps(grid, separators=(",", ":")))
    log.info("updated %s", grid_path)


if __name__ == "__main__":
    main()
