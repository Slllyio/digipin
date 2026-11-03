"""Ground that could liquefy in an earthquake, Greater Chennai: a published liquefaction susceptibility map (Zenodo, CC BY 4.0).

Manoharan and Ganapathy's first-level assessment of Greater Chennai ("Integrated seismic hazard and liquefaction
susceptibility mapping of a coastal megacity", dataset on Zenodo, record 19105121) scores every 20 m pixel for
liquefaction susceptibility by weighting lithology, geomorphology, depth to groundwater (ward wells 2016-2020) and depth
to bedrock (AHP weights), then overlays surface ground shaking (PGA amplified by soil type) into a seismic hazard
class. Only the authors' derived rasters are read; the GSI source layers are not used. Per lived-in L7 block inside the
mapped area (dataset ``liquefaction``), over the pixels within ``RADIUS_M`` of the block centre:

    lq_index        mean liquefaction susceptibility score (1-3.5)
    lq_likely_pct   share of pixels in the authors' "liquefaction likely" class (score above 2.75)
    lq_possible_pct share "possibly" (2.2-2.75)
    sh_index        mean seismic hazard score (0-3.4)
    sh_high_pct     share of pixels in the "high" seismic hazard class (above 3)

    python -m pipeline.realestate.liquefaction
"""
from __future__ import annotations

import argparse
import io
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
URL = "https://zenodo.org/api/records/19105121/files/Greater_Chennai_Seismic_Hazard_Dataset.zip/content"
LIQ = "Liquefaction_Sus_new_AHP.tif"
SHA = "SHA_New.tif"
RADIUS_M = 120
LIKELY, POSSIBLE, HIGH = 2.75, 2.2, 3.0     # class breaks from the authors' QGIS project


def window_values(arr, transform, x, y, radius):
    """Finite, positive pixel values within ``radius`` (map units) of (x, y)."""
    import numpy as np
    col, row = ~transform * (x, y)
    px = abs(transform.a)
    r = int(radius / px) + 1
    r0, c0 = int(row), int(col)
    if r0 < -r or c0 < -r or r0 >= arr.shape[0] + r or c0 >= arr.shape[1] + r:
        return np.array([])
    rows = slice(max(r0 - r, 0), min(r0 + r + 1, arr.shape[0]))
    cols = slice(max(c0 - r, 0), min(c0 + r + 1, arr.shape[1]))
    sub = arr[rows, cols]
    yy, xx = np.mgrid[rows, cols]
    d = np.hypot((xx + 0.5 - col) * px, (yy + 0.5 - row) * px)
    v = sub[d <= radius]
    return v[np.isfinite(v) & (v > 0)]


def block_rows(points, liq, sha, transform, radius=RADIUS_M):
    """{code: fields} from block centres [(code, x, y)] in the rasters' CRS; blocks with under 10 mapped pixels are skipped."""
    rows = {}
    for code, x, y in points:
        lv = window_values(liq, transform, x, y, radius)
        if lv.size < 10:
            continue
        r = {"lq_index": round(float(lv.mean()), 2), "lq_likely_pct": round(100 * float((lv > LIKELY).mean())),
             "lq_possible_pct": round(100 * float(((lv > POSSIBLE) & (lv <= LIKELY)).mean()))}
        sv = window_values(sha, transform, x, y, radius)
        if sv.size >= 10:
            r.update(sh_index=round(float(sv.mean()), 2), sh_high_pct=round(100 * float((sv > HIGH).mean())))
        rows[code] = r
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("lq_likely_pct", "Ground where liquefaction is likely (share of block)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("lq_possible_pct", "Ground where liquefaction is possible (share of block)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("lq_index", "Liquefaction susceptibility score (1-3.5)", agg="mean", domain=[1, 3.5], ramp="reds", higher_is="worse"),
        FieldSpec("sh_index", "Seismic hazard score (0-3.4)", agg="mean", domain=[0, 3.4], ramp="reds", higher_is="worse"),
        FieldSpec("sh_high_pct", "Ground in the high seismic hazard class (share of block)", agg="mean", unit="%", domain=[0, 100], ramp="reds", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="liquefaction", title="Liquefaction susceptibility and seismic hazard (Greater Chennai)", level=LEVEL, fields=specs,
        group="Hazards",
        description="Share of each block on ground scored likely or possibly to liquefy in an earthquake, and its seismic hazard "
                    "class, from Manoharan and Ganapathy's first-level GIS assessment of Greater Chennai (lithology, "
                    "geomorphology, groundwater and bedrock depth, AHP weights; 20 m). Zenodo record 19105121, CC BY 4.0.",
        source="pipeline/realestate/liquefaction.py (Zenodo 19105121 derived rasters)",
        license="CC BY 4.0 (S. G. Manoharan and G. P. Ganapathy, Zenodo 19105121)", default_field="lq_likely_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    import numpy as np
    import rasterio
    import requests
    from rasterio.io import MemoryFile
    from rasterio.warp import transform as warp

    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="chennai")
    region = ap.parse_args(argv).region
    z = zipfile.ZipFile(io.BytesIO(requests.get(URL, timeout=300).content))
    read = lambda name: next(n for n in z.namelist() if n.endswith("/" + name))
    rasters = {}
    for name in (LIQ, SHA):
        with MemoryFile(z.read(read(name))) as mf, mf.open() as ds:
            a = ds.read(1).astype("float64")
            if ds.nodata is not None:
                a[a == ds.nodata] = np.nan
            rasters[name] = (a, ds.transform, ds.crs)
    liq, tf, crs = rasters[LIQ]
    sha = rasters[SHA][0]
    assert rasters[SHA][1] == tf, "rasters must share a grid"
    cells = lived_cells(region)
    xs, ys = warp("EPSG:4326", crs, [c[2] for c in cells], [c[1] for c in cells])
    rows = block_rows([(c[0], x, y) for c, x, y in zip(cells, xs, ys)], liq, sha, tf)
    cell_dataset(region, rows)
    print(f"{region}: {len(rows)} blocks mapped, {sum(1 for r in rows.values() if r['lq_likely_pct'] >= 50)} mostly on ground likely to liquefy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
