"""Building fabric per block: footprint shape and arrangement from Overture Maps buildings (ODbL).

Overture's India buildings merge OpenStreetMap, Google Open Buildings and Microsoft ML footprints. For every footprint we
measure shape the way momepy / urbanity do (Fleischmann 2019; Yap et al. 2022, urbanity, MIT; momepy, BSD-3), on a local
metre projection, then summarise per L7 block (dataset ``building_form``) by the centroid's block:

    bf_count          footprints in the block
    bf_area_m2        median footprint area
    bf_compact        median circular compactness: area / area of the smallest enclosing circle (1 = round, low = thin)
    bf_elong          median elongation: short side / long side of the minimum rotated rectangle (1 = square)
    bf_align          how well footprints share one grid, 0-100: length of the mean 4-fold orientation vector
                      |mean(exp(4i*theta))| over footprints (theta = long-axis bearing); 100 = all on one grid
    bf_attached_pct   share of footprints within 1 m of another (attached / row / terraced)
    bf_shared_wall    mean share of a footprint's outline that runs within 1 m of a neighbour (shared wall ratio), %
    bf_gap_m          median distance to the nearest other footprint (m, capped at 100)

Blocks with fewer than 5 footprints are left out (the medians would be noise).

    python -m pipeline.realestate.buildingform [--region all]
"""
from __future__ import annotations

import argparse
import math
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RELEASE = "2026-10-21.0"
MIN_BUILDINGS = 5
TOUCH_M = 1.0
GAP_CAP_M = 100.0
TILE_DEG = 0.06
MARGIN_DEG = 0.0015


def to_metres(lat0):
    """Local equirectangular metres (fine for shape metrics within a city)."""
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 110_540.0
    return kx, ky


def shape_metrics(geoms):
    """Per-footprint metrics for an array of projected (metre) polygons. Pure (shapely 2 + numpy).

    Returns dict of numpy arrays: area, compact, elong, regular, theta (long-axis bearing in radians, 0..pi).
    """
    import numpy as np
    import shapely
    area = shapely.area(geoms)
    r = shapely.minimum_bounding_radius(geoms)
    compact = np.where(r > 0, area / (math.pi * r * r), np.nan)
    mrr = shapely.oriented_envelope(geoms)
    coords, idx = shapely.get_coordinates(shapely.get_exterior_ring(mrr), return_index=True)
    # first three vertices of each rectangle ring
    first = np.searchsorted(idx, np.arange(len(geoms)))
    p0, p1, p2 = coords[first], coords[first + 1], coords[first + 2]
    a = np.hypot(*(p1 - p0).T)
    b = np.hypot(*(p2 - p1).T)
    long_vec = np.where((a >= b)[:, None], p1 - p0, p2 - p1)
    theta = np.mod(np.arctan2(long_vec[:, 1], long_vec[:, 0]), math.pi)
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    elong = np.where(hi > 0, lo / hi, np.nan)
    mrr_area = a * b
    regular = np.where(mrr_area > 0, np.minimum(area / mrr_area, 1.0), np.nan)
    return {"area": area, "compact": compact, "elong": elong, "regular": regular, "theta": theta}


def alignment(theta):
    """Grid alignment 0-100 from long-axis bearings (radians): |mean(exp(4i*theta))| (4-fold symmetry). Pure."""
    import numpy as np
    theta = np.asarray(theta, dtype=float)
    theta = theta[np.isfinite(theta)]
    if len(theta) == 0:
        return None
    return float(np.hypot(np.cos(4 * theta).mean(), np.sin(4 * theta).mean()) * 100)


def neighbour_metrics(geoms):
    """attached (bool), shared wall ratio (0-1) and nearest-neighbour gap (m) per projected footprint. Pure."""
    import numpy as np
    import shapely
    n = len(geoms)
    tree = shapely.STRtree(geoms)
    left, right = tree.query(geoms, predicate="dwithin", distance=TOUCH_M)
    keep = left != right
    left, right = left[keep], right[keep]
    attached = np.zeros(n, dtype=bool)
    attached[left] = True
    shared = np.zeros(n)
    if len(left):
        bufs = shapely.buffer(geoms, TOUCH_M, quad_segs=2)
        rings = shapely.get_exterior_ring(geoms)
        step = 400_000
        for s in range(0, len(left), step):
            l, r = left[s:s + step], right[s:s + step]
            shared_len = shapely.length(shapely.intersection(rings[l], bufs[r]))
            np.add.at(shared, l, shared_len)
    perim = shapely.length(shapely.get_exterior_ring(geoms))
    swr = np.where(perim > 0, np.minimum(shared / np.maximum(perim, 1e-9), 1.0), np.nan)
    idx, dist = tree.query_nearest(geoms, exclusive=True, return_distance=True, max_distance=GAP_CAP_M)
    gap = np.full(n, GAP_CAP_M)
    np.minimum.at(gap, idx[0], dist)
    return attached, swr, gap


def block_rows(codes, m, attached, swr, gap):
    """Aggregate per-footprint arrays by block code into records. Pure."""
    import numpy as np
    order = np.argsort(codes, kind="stable")
    codes_sorted = codes[order]
    uniq, starts = np.unique(codes_sorted, return_index=True)
    ends = list(starts[1:]) + [len(codes_sorted)]
    out = []
    for code, s, e in zip(uniq, starts, ends):
        ii = order[s:e]
        if len(ii) < MIN_BUILDINGS:
            continue
        med = lambda a: float(np.nanmedian(a[ii]))  # noqa: E731
        out.append({
            "digipin": str(code), "bf_count": int(len(ii)), "bf_area_m2": med(m["area"]),
            "bf_compact": med(m["compact"]), "bf_elong": med(m["elong"]),
            "bf_align": alignment(m["theta"][ii]), "bf_attached_pct": float(attached[ii].mean() * 100),
            "bf_shared_wall": float(np.nanmean(swr[ii]) * 100), "bf_gap_m": med(gap),
        })
    return out


def fetch(region, release=RELEASE):
    """(wkb list, centroid lng array, centroid lat array) for footprints whose bbox centre lies in the region box."""
    import duckdb
    import numpy as np
    from pipeline._lib.regions import bbox_for
    w, s, e, n = bbox_for(region)
    for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(k, None)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    base = f"s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*"
    rows = con.execute(f"""
        SELECT ST_AsWKB(geometry), (bbox.xmin + bbox.xmax) / 2 AS x, (bbox.ymin + bbox.ymax) / 2 AS y
        FROM read_parquet('{base}')
        WHERE bbox.xmin < {e} AND bbox.xmax > {w} AND bbox.ymin < {n} AND bbox.ymax > {s}""").fetchall()
    wkb = [bytes(r[0]) for r in rows]
    x = np.array([r[1] for r in rows])
    y = np.array([r[2] for r in rows])
    return wkb, x, y, (w, s, e, n)


def bake(region):
    import numpy as np
    import shapely
    from pipeline.cells.store import cell_code
    wkb, x, y, (w, s, e, n) = fetch(region)
    inside = (x >= w) & (x <= e) & (y >= s) & (y <= n)
    kx, ky = to_metres((s + n) / 2)
    recs = []
    for tx in np.arange(w, e, TILE_DEG):
        for ty in np.arange(s, n, TILE_DEG):
            core = inside & (x >= tx) & (x < tx + TILE_DEG) & (y >= ty) & (y < ty + TILE_DEG)
            if core.sum() == 0:
                continue
            near = ((x >= tx - MARGIN_DEG) & (x < tx + TILE_DEG + MARGIN_DEG)
                    & (y >= ty - MARGIN_DEG) & (y < ty + TILE_DEG + MARGIN_DEG))
            sel = np.nonzero(near)[0]
            g = shapely.from_wkb([wkb[i] for i in sel])
            g = shapely.transform(g, lambda c: np.column_stack(((c[:, 0] - w) * kx, (c[:, 1] - s) * ky)))
            # keep the largest part of multipolygons
            multi = shapely.get_type_id(g) == 6
            if multi.any():
                g[multi] = [max(p.geoms, key=lambda q: q.area) for p in g[multi]]
            ok = shapely.is_valid(g) & (shapely.area(g) >= 4)
            g, sel = g[ok], sel[ok]
            attached, swr, gap = neighbour_metrics(g)
            is_core = core[sel]
            gc = g[is_core]
            m = shape_metrics(gc)
            codes = np.array([cell_code(LEVEL, float(yy), float(xx)) for xx, yy in zip(x[sel][is_core], y[sel][is_core])])
            recs.extend(block_rows(codes, m, attached[is_core], swr[is_core], gap[is_core]))
    return recs, int(inside.sum())


FIELDS = [
    ("bf_count", "Building footprints", "sum", "buildings", "viridis", None),
    ("bf_area_m2", "Median footprint area", "mean", "m²", "viridis", None),
    ("bf_compact", "Footprint compactness (circle = 1)", "mean", "0-1", "viridis", None),
    ("bf_elong", "Footprint elongation (square = 1)", "mean", "0-1", "viridis", None),
    ("bf_align", "Buildings on one grid", "mean", "0-100", "viridis", None),
    ("bf_attached_pct", "Attached buildings", "mean", "% of buildings", "reds", None),
    ("bf_shared_wall", "Shared wall ratio", "mean", "% of outline", "reds", None),
    ("bf_gap_m", "Median gap to nearest building", "mean", "m", "viridis", None),
]


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec(k, label, agg=agg, unit=unit, ramp=ramp, higher_is=hi) for k, label, agg, unit, ramp, hi in FIELDS]
    spec = DatasetSpec(
        id="building_form", title="Building fabric (footprint shape and arrangement)", level=LEVEL, fields=specs,
        group="Buildings",
        description=f"Footprint shape and arrangement per block from Overture Maps buildings (release {RELEASE}: "
                    "OpenStreetMap, Google Open Buildings and Microsoft ML footprints). Medians of footprint area, "
                    "circular compactness and elongation (ML footprints are almost all rectangles, so rectangularity is not kept); grid alignment of long axes (4-fold "
                    "orientation order); share of attached footprints and shared wall ratio (within 1 m); median gap "
                    "to the nearest footprint. Methods after momepy and urbanity (Fleischmann 2019; Yap et al. 2022). "
                    f"Blocks with fewer than {MIN_BUILDINGS} footprints left out.",
        source="pipeline/realestate/buildingform.py (Overture Maps buildings)",
        license="ODbL (OpenStreetMap contributors via Overture Maps; Google Open Buildings CC BY 4.0; Microsoft ML Buildings ODbL)",
        default_field="bf_attached_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for region in (CITY_PILOTS if a.region == "all" else a.region.split(",")):
        recs, total = bake(region)
        info = cell_dataset(region, recs)
        print(f"{region}: {total} footprints, {info['cells']} blocks", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
