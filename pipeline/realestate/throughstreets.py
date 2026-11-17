"""Through streets: local street betweenness within 1.2 km per block (Overture Maps streets, ODbL).

urbanity computes graph centralities on city street networks (Yap et al. 2023, MIT). Measured with a radius cut-off,
edge betweenness counts how many shortest walks between street junctions up to 1.2 km apart (about 15 minutes) pass along
each street link: Sevtsuk's local "through-movement" potential, which tracks where foot traffic and shopfronts gather
(Sevtsuk 2010, 2014; Hillier's local choice). DigiPin's traffic model already does city-wide car betweenness; this is the
walking-scale version. Graph: public streets (trunk to residential, unclassified, living and pedestrian) split at every
Overture connector, undirected, weighted by length. Per L7 block (dataset ``through_streets``), from links whose middle
lies in the block:

    ts_max       highest link betweenness in the block (shortest walks passing, thousands)
    ts_mean      length-weighted mean link betweenness (thousands)

    python -m pipeline.realestate.throughstreets [--region all]
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
RADIUS_M = 1200.0
STREETS = ("trunk", "primary", "secondary", "tertiary", "residential", "living_street", "unclassified", "pedestrian")


def fetch(region, release=RELEASE):
    import duckdb
    from pipeline._lib.regions import bbox_for
    w, s, e, n = bbox_for(region)
    for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        os.environ.pop(k, None)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    base = f"s3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*"
    keep = ", ".join(f"'{c}'" for c in STREETS)
    rows = con.execute(f"""
        SELECT ST_AsWKB(geometry), [c.connector_id for c in connectors], [c.at for c in connectors]
        FROM read_parquet('{base}')
        WHERE subtype = 'road' AND class IN ({keep})
          AND bbox.xmin < {e} AND bbox.xmax > {w} AND bbox.ymin < {n} AND bbox.ymax > {s}""").fetchall()
    return rows, (w, s, e, n)


def links(rows, lat0):
    """Split segments at connectors -> (u ids, v ids, length m, mid lng, mid lat). Pure (shapely + numpy)."""
    import numpy as np
    import shapely
    kx, ky = 111_320.0 * math.cos(math.radians(lat0)), 110_540.0
    geoms = shapely.from_wkb([bytes(r[0]) for r in rows])
    seg_len = []
    for g in geoms:
        c = shapely.get_coordinates(g)
        d = np.diff(c, axis=0) * [kx, ky]
        seg_len.append(float(np.hypot(d[:, 0], d[:, 1]).sum()))
    U, V, L, gi, fm = [], [], [], [], []
    for i, (_, ids, ats) in enumerate(rows):
        pts = sorted(((a if a is not None else 0.0), c) for c, a in zip(ids or [], ats or []))
        for (a0, c0), (a1, c1) in zip(pts[:-1], pts[1:]):
            if c0 == c1 or a1 - a0 <= 1e-9:
                continue
            U.append(c0)
            V.append(c1)
            L.append((a1 - a0) * seg_len[i])
            gi.append(i)
            fm.append((a0 + a1) / 2)
    mid = shapely.get_coordinates(shapely.line_interpolate_point(geoms[np.array(gi, dtype=int)], np.array(fm), normalized=True))
    return U, V, np.array(L), mid[:, 0], mid[:, 1]


def betweenness(U, V, L, radius=RADIUS_M):
    """Edge betweenness with a path-length cut-off on the undirected, length-weighted graph (igraph)."""
    import igraph as ig
    names = {}
    for x in U + V:
        if x not in names:
            names[x] = len(names)
    g = ig.Graph(n=len(names), edges=[(names[a], names[b]) for a, b in zip(U, V)], directed=False)
    g.es["w"] = [max(float(x), 0.1) for x in L]
    return g.edge_betweenness(directed=False, cutoff=radius, weights="w")


def block_rows(codes, bet, L):
    """Per-block max and length-weighted mean betweenness (thousands of shortest walks). Pure."""
    acc = {}
    for c, b, ln in zip(codes, bet, L):
        if not c:
            continue
        a = acc.setdefault(c, [0.0, 0.0, 0.0])
        a[0] = max(a[0], b)
        a[1] += b * ln
        a[2] += ln
    return [{"digipin": c, "ts_max": mx / 1000, "ts_mean": (s / ln) / 1000 if ln else None} for c, (mx, s, ln) in sorted(acc.items())]


FIELDS = [
    ("ts_max", "Busiest through street in the block (1.2 km walks passing)", "max", "thousand walks", "heat", None),
    ("ts_mean", "Mean through-movement of the block's streets", "mean", "thousand walks", "heat", None),
]


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec(k, label, agg=agg, unit=unit, ramp=ramp, higher_is=hi) for k, label, agg, unit, ramp, hi in FIELDS]
    spec = DatasetSpec(
        id="through_streets", title="Through streets (local betweenness, 1.2 km)", level=LEVEL, fields=specs, group="Mobility",
        description=f"Walking-scale through-movement: edge betweenness with a {int(RADIUS_M)} m path cut-off on Overture Maps "
                    f"public streets (release {RELEASE}) split at every connector. Per block, the busiest link and the "
                    "length-weighted mean, in thousands of shortest walks passing. After urbanity's network centralities "
                    "and Sevtsuk's local betweenness.",
        source="pipeline/realestate/throughstreets.py (Overture Maps transportation, igraph)",
        license="ODbL (OpenStreetMap contributors, via Overture Maps)", default_field="ts_max", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import time
    from pipeline._lib.regions import CITY_PILOTS
    from pipeline.cells.store import cell_code
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for region in (CITY_PILOTS if a.region == "all" else a.region.split(",")):
        t = time.time()
        rows, (w, s, e, n) = fetch(region)
        U, V, L, mx, my = links(rows, (s + n) / 2)
        bet = betweenness(U, V, L)
        codes = [cell_code(LEVEL, float(y), float(x)) if (w <= x <= e and s <= y <= n) else None for x, y in zip(mx, my)]
        info = cell_dataset(region, block_rows(codes, bet, L))
        print(f"{region}: {len(L)} links, {info['cells']} blocks, {time.time() - t:.0f} s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
