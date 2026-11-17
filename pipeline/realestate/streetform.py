"""Street pattern per block: grid order, winding, link length and street-block size from Overture Maps streets (ODbL).

Network form indicators in the spirit of urbanity's street network attributes (Yap et al. 2022, urbanity, MIT) and
OSMnx (Boeing 2019, 2021). Same public-street filter as ``street_grid`` (trunk to residential, unclassified, living and
pedestrian streets). Per L7 block (dataset ``street_form``):

    sf_order      street orientation order, 0-100 (Boeing 2019): 1 - ((H - H_grid) / (H_max - H_grid))^2 over a 36-bin,
                  length-weighted histogram of street bearings within the surrounding 5 x 5 blocks (about 1.2 km).
                  100 = a perfect grid, 0 = streets running every which way
    sf_circuity   street circuity: link length along the street / straight distance between its two ends (>= 1)
    sf_link_m     median street link length between junctions (m)
    sf_block_ha   median area of the street blocks (land fully ringed by streets) centred in the block (ha)
    sf_km_km2     street length per km² of block

    python -m pipeline.realestate.streetform [--region all]
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
STREETS = ("trunk", "primary", "secondary", "tertiary", "residential", "living_street", "unclassified", "pedestrian")
BINS = 36
WINDOW = 2  # blocks either side -> 5 x 5
MIN_ORDER_KM = 1.0  # need at least this much street in the window for an order value
TILE_DEG = 0.06
MARGIN_DEG = 0.004
MAX_BLOCK_HA = 50.0


def orientation_order(hist):
    """Boeing (2019) orientation order from a length-weighted bearing histogram (BINS bins over 0-360). Pure."""
    total = sum(hist)
    if total <= 0:
        return None
    h = -sum((v / total) * math.log(v / total) for v in hist if v > 0)
    h_max, h_grid = math.log(BINS), math.log(4)
    return max(0.0, min(1.0, 1 - ((h - h_grid) / (h_max - h_grid)) ** 2))


def bearing_hist(dx, dy, length):
    """Bidirectional 36-bin histograms: each piece adds its length at its bearing and the reverse bearing. Pure (numpy)."""
    import numpy as np
    b = np.mod(np.degrees(np.arctan2(dx, dy)), 360.0)  # compass bearing
    # centre bins on 0, 10, 20 ... (Boeing's convention avoids splitting N/S/E/W across two bins)
    k1 = (np.floor((b + 5) / 10) % BINS).astype(int)
    k2 = (k1 + BINS // 2) % BINS
    return k1, k2, length


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
        SELECT ST_AsWKB(geometry), [c.at for c in connectors] FROM read_parquet('{base}')
        WHERE subtype = 'road' AND class IN ({keep})
          AND bbox.xmin < {e} AND bbox.xmax > {w} AND bbox.ymin < {n} AND bbox.ymax > {s}""").fetchall()
    return [bytes(r[0]) for r in rows], [r[1] or [] for r in rows], (w, s, e, n)


def bake(region):
    import numpy as np
    import shapely
    from pipeline._lib.digipin import cell_size_m, to_index
    from pipeline.cells.store import cell_code
    wkb, ats, (w, s, e, n) = fetch(region)
    lat0 = (s + n) / 2
    kx, ky = 111_320.0 * math.cos(math.radians(lat0)), 110_540.0
    lines = shapely.from_wkb(wkb)
    proj = shapely.transform(lines, lambda c: np.column_stack(((c[:, 0] - w) * kx, (c[:, 1] - s) * ky)))
    unproj = lambda X, Y: (X / kx + w, Y / ky + s)  # noqa: E731

    def code_of(X, Y):
        lng, lat = unproj(X, Y)
        return np.array([cell_code(LEVEL, float(a), float(b)) or "" for a, b in zip(lat, lng)])

    # 1. pieces -> length + bearing histograms per block
    coords, idx = shapely.get_coordinates(proj, return_index=True)
    same = idx[1:] == idx[:-1]
    p0, p1 = coords[:-1][same], coords[1:][same]
    d = p1 - p0
    plen = np.hypot(d[:, 0], d[:, 1])
    ok = plen > 0.5
    p0, d, plen = p0[ok], d[ok], plen[ok]
    mid = p0 + d / 2
    inside = (mid[:, 0] >= 0) & (mid[:, 0] <= (e - w) * kx) & (mid[:, 1] >= 0) & (mid[:, 1] <= (n - s) * ky)
    mid, d, plen = mid[inside], d[inside], plen[inside]
    pcode = code_of(mid[:, 0], mid[:, 1])
    k1, k2, L = bearing_hist(d[:, 0], d[:, 1], plen)
    hist, km = {}, {}
    for c, a, b, ln in zip(pcode, k1, k2, L):
        if not c:
            continue
        h = hist.get(c)
        if h is None:
            h = hist[c] = [0.0] * BINS
        h[a] += ln
        h[b] += ln
        km[c] = km.get(c, 0.0) + ln / 1000

    # 2. links between consecutive connectors: circuity and length, by link midpoint
    li, fa, fb = [], [], []
    for i, at in enumerate(ats):
        pts = sorted({0.0, 1.0, *[float(x) for x in at if x is not None]})
        for a, b in zip(pts[:-1], pts[1:]):
            if b - a > 1e-6:
                li.append(i)
                fa.append(a)
                fb.append(b)
    li, fa, fb = np.array(li), np.array(fa), np.array(fb)
    seglen = shapely.length(proj)[li]
    link_len = (fb - fa) * seglen
    pa = shapely.get_coordinates(shapely.line_interpolate_point(proj[li], fa, normalized=True))
    pb = shapely.get_coordinates(shapely.line_interpolate_point(proj[li], fb, normalized=True))
    pm = shapely.get_coordinates(shapely.line_interpolate_point(proj[li], (fa + fb) / 2, normalized=True))
    straight = np.hypot(*(pb - pa).T)
    good = (link_len > 10) & (straight > 1)
    lcode = code_of(pm[good, 0], pm[good, 1])
    links = {}
    for c, ll, st in zip(lcode, link_len[good], straight[good]):
        if c:
            links.setdefault(c, []).append((ll, st))

    # 3. street blocks (polygonize, tiled)
    blocks = {}
    bounds = shapely.bounds(proj)
    W, H = (e - w) * kx, (n - s) * ky
    tile, marg = TILE_DEG * kx, MARGIN_DEG * kx
    for tx in np.arange(0, W, tile):
        for ty in np.arange(0, H, tile):
            sel = ((bounds[:, 2] >= tx - marg) & (bounds[:, 0] <= tx + tile + marg)
                   & (bounds[:, 3] >= ty - marg) & (bounds[:, 1] <= ty + tile + marg))
            if sel.sum() < 4:
                continue
            noded = shapely.union_all(proj[sel])
            polys = shapely.get_parts(shapely.polygonize(shapely.get_parts(noded)))
            if not len(polys):
                continue
            cen = shapely.get_coordinates(shapely.centroid(polys))
            core = (cen[:, 0] >= tx) & (cen[:, 0] < tx + tile) & (cen[:, 1] >= ty) & (cen[:, 1] < ty + tile)
            area_ha = shapely.area(polys)[core] / 10_000
            keep = (area_ha >= 0.05) & (area_ha <= MAX_BLOCK_HA)
            cc = code_of(cen[core][keep, 0], cen[core][keep, 1])
            for c, a in zip(cc, area_ha[keep]):
                if c:
                    blocks.setdefault(c, []).append(a)

    # 4. per block records; order over the 5 x 5 window
    cell_km2 = (cell_size_m(LEVEL) / 1000) ** 2
    rc = {c: to_index(c) for c in hist}
    by_rc = {(v["row"], v["col"]): c for c, v in rc.items()}
    recs = []
    for c in sorted(set(hist) | set(links) | set(blocks)):
        r = {"digipin": c}
        if c in rc:
            row, col = rc[c]["row"], rc[c]["col"]
            tot = [0.0] * BINS
            for dr in range(-WINDOW, WINDOW + 1):
                for dc in range(-WINDOW, WINDOW + 1):
                    nb = by_rc.get((row + dr, col + dc))
                    if nb:
                        for k, v in enumerate(hist[nb]):
                            tot[k] += v
            if sum(tot) / 2000 >= MIN_ORDER_KM:
                o = orientation_order(tot)
                r["sf_order"] = None if o is None else o * 100
            r["sf_km_km2"] = km.get(c, 0.0) / cell_km2
        if c in links:
            arr = np.array(links[c])
            r["sf_circuity"] = float(arr[:, 0].sum() / arr[:, 1].sum())
            r["sf_link_m"] = float(np.median(arr[:, 0]))
        if c in blocks:
            r["sf_block_ha"] = float(np.median(blocks[c]))
        recs.append(r)
    return recs, len(wkb)


FIELDS = [
    ("sf_order", "Street grid order (100 = perfect grid)", "mean", "0-100", "viridis", None),
    ("sf_circuity", "Street circuity (1 = straight)", "mean", "ratio", "reds", None),
    ("sf_link_m", "Median street link length", "mean", "m", "viridis", None),
    ("sf_block_ha", "Median street-block size", "mean", "ha", "viridis", None),
    ("sf_km_km2", "Street length per km²", "mean", "km/km²", "viridis", "better"),
]


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [FieldSpec(k, label, agg=agg, unit=unit, ramp=ramp, higher_is=hi) for k, label, agg, unit, ramp, hi in FIELDS]
    spec = DatasetSpec(
        id="street_form", title="Street pattern (grid order, circuity, link and block size)", level=LEVEL, fields=specs,
        group="Mobility",
        description=f"Street network form per block from Overture Maps transportation segments (release {RELEASE}, from "
                    "OpenStreetMap; public streets trunk to residential, unclassified, living and pedestrian). Orientation "
                    "order (Boeing 2019) over the surrounding 5 x 5 blocks, circuity and median length of links between "
                    "junctions, median street-block area (land ringed by streets) and street density. After urbanity "
                    "(Yap et al. 2022) and OSMnx.",
        source="pipeline/realestate/streetform.py (Overture Maps transportation)",
        license="ODbL (OpenStreetMap contributors, via Overture Maps)", default_field="sf_order", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for region in (CITY_PILOTS if a.region == "all" else a.region.split(",")):
        recs, total = bake(region)
        info = cell_dataset(region, recs)
        print(f"{region}: {total} street segments, {info['cells']} blocks", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
