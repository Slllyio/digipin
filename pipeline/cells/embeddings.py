"""Satellite embeddings per block: "find places like this" and how much a block has changed.

Google's Satellite Embedding V1 (AlphaEarth Foundations) gives every 10 m pixel a
64-number summary of a year of Sentinel-1/2, Landsat, terrain and climate. Per L7
block (dataset ``embeddings``):

    e0 … e11        first 12 principal components of the block's mean 2025
                    embedding (one PCA fitted across all cities, so blocks in
                    different cities compare directly)
    change_8yr      1 − cosine similarity of the block's mean embedding 2017 vs 2025
    change_2yr      the same for 2023 vs 2025

Two passes: ``fetch`` caches each city's raw 64-d means under data/cache/embeddings,
then ``write`` fits the PCA across every cached city and writes the store.

    python -m pipeline.cells.embeddings fetch --region delhi
    python -m pipeline.cells.embeddings write
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.cells import earthengine as gee

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
CACHE = REPO / "data" / "cache" / "embeddings"
LEVEL = 7
YEARS = (2017, 2023, 2025)
DIMS = 12
SCALE_M = 20


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def cosine(a, b):
    """Cosine similarity of two equal-length vectors; None if either is all zero."""
    num = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return num / (na * nb) if na and nb else None


def pca(rows, k):
    """(mean, components) of the rows (list of equal-length lists), top-k by variance."""
    import numpy as np
    x = np.asarray(rows, dtype="float64")
    mu = x.mean(axis=0)
    _, s, vt = np.linalg.svd(x - mu, full_matrices=False)
    return mu, vt[:k], (s[:k] ** 2) / (s ** 2).sum()


# ── Earth Engine ────────────────────────────────────────────────────────────

def fetch(region):
    ee = gee.init()
    w, s, e, n = bbox_for(region)
    geom = ee.Geometry.Rectangle([w, s, e, n])
    col = ee.ImageCollection("GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL").filterBounds(geom)
    out = {}
    for y in YEARS:
        img = col.filter(ee.Filter.calendarRange(y, y, "year")).mosaic()
        raw = gee.fetch(gee.to_cells(img, SCALE_M), (w, s, e, n), LEVEL, tile=48)
        for code, x in raw.items():
            v = [x.get(f"A{i:02d}") for i in range(64)]
            if any(t is None for t in v):
                continue
            out.setdefault(code, {})[str(y)] = [round(t, 4) for t in v]
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / f"{region}.json").write_text(json.dumps(out))
    return len(out)


def write(regions):
    import numpy as np

    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    data = {r: json.loads((CACHE / f"{r}.json").read_text()) for r in regions if (CACHE / f"{r}.json").exists()}
    last = str(YEARS[-1])
    sample = [v[last] for d in data.values() for v in list(d.values())[::7] if last in v]
    mu, comp, var = pca(sample, DIMS)
    print(f"PCA on {len(sample)} blocks: {DIMS} components explain {100 * var.sum():.0f}% of variance")
    specs = [FieldSpec(f"e{k}", f"Embedding component {k + 1}", agg="mean", unit="score", ramp="viridis") for k in range(DIMS)]
    specs += [
        FieldSpec("change_8yr", "Change since 2017 (satellite embedding)", agg="mean", unit="0-1", domain=[0, 0.15], ramp="reds", higher_is=None),
        FieldSpec("change_2yr", "Change since 2023 (satellite embedding)", agg="mean", unit="0-1", domain=[0, 0.1], ramp="reds", higher_is=None),
    ]
    spec = DatasetSpec(
        id="embeddings", title="Satellite embeddings (AlphaEarth)", level=LEVEL, fields=specs, group="Open Data (satellite)",
        description=f"Google Satellite Embedding V1 (AlphaEarth Foundations): a 64-number summary per 10 m pixel of a year "
                    f"of optical, radar, thermal, terrain and climate data. Each block holds the first {DIMS} principal "
                    f"components of its mean {last} embedding (one PCA across all cities, {100 * var.sum():.0f}% of the "
                    "variance), used to find look-alike blocks anywhere, and the change since 2017 and 2023 as 1 − cosine "
                    "similarity of the block's mean embeddings. Change catches new building, cleared land, new water and "
                    "greening alike: it says how much, not what.",
        source="GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL via Earth Engine (pipeline/cells/embeddings.py)",
        license="CC BY 4.0 (Google Satellite Embedding)", default_field="change_8yr")
    for r, d in data.items():
        rows = []
        for code, v in d.items():
            if last not in v:
                continue
            z = (np.asarray(v[last]) - mu) @ comp.T
            row = {"digipin": code, **{f"e{k}": round(float(z[k]), 3) for k in range(DIMS)}}
            for key, y in (("change_8yr", YEARS[0]), ("change_2yr", YEARS[-2])):
                c = cosine(v[str(y)], v[last]) if str(y) in v else None
                row[key] = round(1 - c, 4) if c is not None else None
            rows.append(row)
        store.write_dataset(CELLS, spec, r, store.bin_records(rows, LEVEL, specs), parquet=False)
        print(r, len(rows))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("step", choices=["fetch", "write"])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    regions = list(CITY_PILOTS) if a.region == "all" else a.region.split(",")
    if a.step == "fetch":
        for r in regions:
            print(r, fetch(r))
    else:
        write(regions)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
