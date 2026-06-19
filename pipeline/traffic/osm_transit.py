"""Merge OSM transit-stop COVERAGE into the traffic grid.

No open GTFS feed exists for Indore (or most Indian city-bus operators), so we
can't compute timetable frequency/headway. Instead we bin OSM-mapped transit
stops onto the grid and score **coverage** — how many stops fall within walking
distance (the cell's 3x3 ≈ neighbourhood) — which is an honest "is transit
reachable here" proxy, not a frequency measure.

Writes these arrays into `traffic_grid.json` (same grid as traffic_grid.py):
  transit_stops[]        — stops within the cell's 3x3 neighbourhood (~walk shed)
  transit_access[]       — 0..100 coverage score (4+ nearby stops ≈ full)
  transit_headway_min[]  — null (unknown without a timetable)
  transit_routes[]       — null (unknown)
  transit_source         — "osm_stops"

`coverage_access` and `bin_stop_counts` are pure (stdlib) and unit-tested.
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from pipeline._lib.regions import get_default_region_name

log = logging.getLogger("pipeline.traffic.osm_transit")


def coverage_access(neighbourhood_stops):
    """0..100 transit-coverage score from #stops within the ~walk-shed. Pure.
    4+ nearby stops ≈ full coverage; linear below that."""
    if not neighbourhood_stops or neighbourhood_stops <= 0:
        return 0
    return int(min(100, neighbourhood_stops * 25))


def _cell_of(lng, lat, grid):
    """Return the (x, y) grid cell for a lng/lat, or (-1, -1) if out of bounds."""
    b = grid["bounds"]
    w, s, e, n = b["west"], b["south"], b["east"], b["north"]
    if not (w <= lng < e and s <= lat < n):
        return -1, -1
    nx, ny = grid["nx"], grid["ny"]
    x = min(nx - 1, int((lng - w) / (e - w) * nx))
    y = min(ny - 1, int((n - lat) / (n - s) * ny))
    return x, y


def bin_stop_counts(stops, grid):
    """Per-cell raw stop counts (row-major) from {lat,lng} stop dicts. Pure."""
    nx, ny = grid["nx"], grid["ny"]
    counts = [0] * (nx * ny)
    for stp in stops:
        lat, lng = stp.get("lat"), stp.get("lng")
        if lat is None or lng is None:
            continue
        x, y = _cell_of(lng, lat, grid)
        if x < 0:
            continue
        counts[y * nx + x] += 1
    return counts


def _neighbourhood_sum(counts, nx, ny, idx):
    """Sum stop counts over the cell's 3x3 neighbourhood (clamped to the grid)."""
    y, x = divmod(idx, nx)
    total = 0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            yy, xx = y + dy, x + dx
            if 0 <= yy < ny and 0 <= xx < nx:
                total += counts[yy * nx + xx]
    return total


def merge_into_grid(grid, stops):
    """Add transit coverage arrays to `grid` in place from OSM stops. Returns grid."""
    nx, ny = grid["nx"], grid["ny"]
    size = nx * ny
    counts = bin_stop_counts(stops, grid)
    t_stops = [0] * size
    t_access = [0] * size
    for i in range(size):
        nbr = _neighbourhood_sum(counts, nx, ny, i)
        t_stops[i] = nbr                       # stops within the ~walk-shed
        t_access[i] = coverage_access(nbr)
    grid["transit_stops"] = t_stops
    grid["transit_access"] = t_access
    grid["transit_headway_min"] = [None] * size
    grid["transit_routes"] = [None] * size
    grid["transit_source"] = "osm_stops"
    covered = sum(1 for v in t_stops if v)
    log.info("transit coverage: %d stops → %d cells covered", sum(counts), covered)
    return grid


def _load_stops(path):
    """Read a GeoJSON file and return its Point features as {lat, lng} dicts."""
    gj = json.loads(Path(path).read_text())
    out = []
    for f in gj.get("features", []):
        g = f.get("geometry", {})
        if g.get("type") == "Point":
            lng, lat = g["coordinates"][:2]
            out.append({"lat": lat, "lng": lng})
    return out


def main():
    """CLI: merge OSM transit-stop coverage into an existing traffic grid."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--stops", default=None, help="osm_transit_<region>.geojson")
    ap.add_argument("--grid", default=None, help="traffic_grid.json to enrich")
    args = ap.parse_args()
    region = get_default_region_name()
    stops_path = Path(args.stops) if args.stops else Path(f"data/vectors/osm_transit_{region}.geojson")
    grid_path = Path(args.grid) if args.grid else Path(f"data/traffic/{region}/traffic_grid.json")
    if not stops_path.exists():
        raise SystemExit(f"missing {stops_path} — run pipeline.traffic.fetch_osm_transit first")
    if not grid_path.exists():
        raise SystemExit(f"missing {grid_path} — run pipeline.traffic.traffic_grid first")
    grid = json.loads(grid_path.read_text())
    merge_into_grid(grid, _load_stops(stops_path))
    grid_path.write_text(json.dumps(grid, separators=(",", ":")))
    log.info("updated %s", grid_path)


if __name__ == "__main__":
    main()
