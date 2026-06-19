"""Aggregate complete building footprints into a small per-cell density grid.

OSM (Overpass) badly undercounts buildings in Tier-2 India, so Building
Intelligence's density/FSI are biased low (RESEARCH_INTEGRATION.md Finding 1).
This bakes the far-more-complete ML footprints — Google Open Buildings v3
(default, no GEE; `pipeline/download_google_buildings.py`), or Microsoft /
Overture — into a committed grid the browser can sample to correct that bias.

Input: a footprints file with per-building centroid + area. Output (small JSON):

    data/buildings/footprint_grid.json
    { "res_m", "bounds": {w,s,e,n}, "nx", "ny",
      "count": [...nx*ny...], "coveragePct": [...], "meanAreaM2": [...] }

Sampled in the browser by lat/lng → grid index. Pure aggregation (`bin_footprints`)
is unit-tested; IO is thin.

Usage:
    python -m pipeline.buildings.footprint_grid --in data/vectors/google_open_buildings_indore.parquet
    python -m pipeline.buildings.footprint_grid --in <ms_or_overture> --res 100
"""
from __future__ import annotations

import argparse
import json
import logging
import math
from pathlib import Path

from pipeline._lib.regions import get_default_bbox, get_default_region_name

log = logging.getLogger("pipeline.buildings.footprint_grid")


def _cell_area_m2(lat, res_m):
    """Ground area in m² of a square res_m cell (constant across the target grid)."""
    # square cells of res_m on the ground; identical everywhere on the target grid
    return float(res_m) * float(res_m)


def bin_footprints(features, bbox, res_m=100):
    """Bin building footprints onto a regular grid over `bbox` (w,s,e,n).

    `features`: iterable of dicts with `lat`, `lng` (centroid) and `area` (m²).
    Returns { res_m, bounds, nx, ny, count[], coveragePct[], meanAreaM2[] } with
    row-major arrays (index = y*nx + x, y from north, matching image convention).
    """
    w, s, e, n = bbox
    deg = res_m / 111_000.0
    nx = max(1, round((e - w) / deg))
    ny = max(1, round((n - s) / deg))
    count = [0] * (nx * ny)
    area = [0.0] * (nx * ny)
    for f in features:
        lat, lng, a = f.get("lat"), f.get("lng"), f.get("area")
        if lat is None or lng is None:
            continue
        if not (w <= lng < e and s <= lat < n):
            continue
        x = min(nx - 1, int((lng - w) / (e - w) * nx))
        y = min(ny - 1, int((n - lat) / (n - s) * ny))   # row 0 = north
        idx = y * nx + x
        count[idx] += 1
        if isinstance(a, (int, float)) and a > 0:
            area[idx] += float(a)
    cell_area = _cell_area_m2((s + n) / 2, res_m)
    coverage = [round(min(100.0, area[i] / cell_area * 100), 2) for i in range(nx * ny)]
    mean_area = [round(area[i] / count[i], 1) if count[i] else 0.0 for i in range(nx * ny)]
    return {
        "res_m": res_m,
        "bounds": {"west": w, "south": s, "east": e, "north": n},
        "nx": nx, "ny": ny,
        "count": count, "coveragePct": coverage, "meanAreaM2": mean_area,
        "source": "ml_footprints",
    }


# ----------------------------------------------------------------- IO
def _load_features(path):
    """Yield {lat,lng,area} from a parquet/geojson footprints file."""
    p = Path(path)
    if p.suffix == ".parquet":
        import pyarrow.parquet as pq
        tbl = pq.read_table(p)
        cols = tbl.column_names
        d = tbl.to_pydict()
        n = len(d[cols[0]])
        for i in range(n):
            yield {
                "lat": d.get("latitude", [None] * n)[i],
                "lng": d.get("longitude", [None] * n)[i],
                "area": d.get("area_in_meters", [None] * n)[i],
            }
    else:  # geojson
        gj = json.loads(p.read_text())
        for feat in gj.get("features", []):
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            lat, lng = None, None
            if geom.get("type") == "Point":
                lng, lat = geom["coordinates"][:2]
            else:
                lat = props.get("latitude")
                lng = props.get("longitude")
            yield {"lat": lat, "lng": lng, "area": props.get("area_in_meters")}


def main():
    """CLI: aggregate building footprints into a built-up density grid."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="footprints parquet/geojson")
    ap.add_argument("--res", type=int, default=100)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    bbox = get_default_bbox()
    region = get_default_region_name()
    grid = bin_footprints(_load_features(args.inp), bbox, args.res)
    out = Path(args.out) if args.out else Path(f"data/buildings/footprint_grid_{region}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(grid, separators=(",", ":")))
    total = sum(grid["count"])
    log.info("wrote %s — %d footprints over %dx%d cells (%.2f KB)",
             out, total, grid["nx"], grid["ny"], out.stat().st_size / 1024)


if __name__ == "__main__":
    main()
