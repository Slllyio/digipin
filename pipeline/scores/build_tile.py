"""Build the precomputed scored tile for a region (A4).

One pass over the analysis grid produces both deliverables:
  (i)  JSON shards (data/scores/<region>/<prefix>.json) + a coverage.json
       manifest — what the frontend reader (js/precomputed-scores.js) looks up;
  (ii) a .pmtiles choropleth (optional, --pmtiles) via geojson_to_pmtiles — a
       rendering artifact, not used for lookup.

Inputs are all local/static (no GEE, no per-click Overpass): a bbox-clipped
.osm.pbf for the feature counts, and GHSL pop + GLO-30 DEM rasters for the
environment. With no --pbf/--rasters it still runs (baseline scores), which is
how the unit test exercises the wiring without large data.

    python -m pipeline.scores.build_tile --region indore_pilot --level 6 \
        --pbf indore.osm.pbf --pop ghsl.tif --dem glo30.tif --out data/scores
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from pipeline._lib import grid, regions
from pipeline.scores import composite, osm_classify, score_grid

SCHEMA_VERSION = 1
DEFAULT_RADIUS_M = 400.0
DEFAULT_SHARD_PREFIX_LEN = 2


def _bbox_dict(t: tuple) -> dict:
    w, s, e, n = t
    return {"west": w, "south": s, "east": e, "north": n}


def _make_counter(pbf: Optional[str], pop: Optional[str], dem: Optional[str], radius_m: float):
    """Compose the OSM counter (if a pbf is given) with the env sampler (if rasters)."""
    env_sampler = None
    if pop or dem:
        from pipeline.scores.env_sampler import make_env_sampler
        env_sampler = make_env_sampler(pop_tif=pop, dem_tif=dem)

    if pbf:
        from pipeline.scores.count_features import build_bins, make_feature_counter
        bins = build_bins(pbf)
        return make_feature_counter(bins, radius_m=radius_m, env_sampler=env_sampler)

    if env_sampler is not None:
        return lambda cell: osm_classify.assemble_data({}, {}, env_sampler(cell))

    return score_grid.empty_feature_counter


def build(
    region: str,
    level: int,
    out_dir: str,
    pbf: Optional[str] = None,
    pop: Optional[str] = None,
    dem: Optional[str] = None,
    radius_m: float = DEFAULT_RADIUS_M,
    shard_prefix_len: int = DEFAULT_SHARD_PREFIX_LEN,
    max_cells: Optional[int] = None,
    pmtiles: bool = False,
) -> dict:
    """Score the region's grid and write shards + coverage.json. Returns a summary."""
    if region not in regions._REGIONS:
        raise ValueError(f"unknown region {region!r}; known: {sorted(regions._REGIONS)}")
    bbox = _bbox_dict(regions._REGIONS[region])
    counter = _make_counter(pbf, pop, dem, radius_m)
    fields = score_grid.score_field_names()

    out = Path(out_dir)
    region_dir = out / region
    region_dir.mkdir(parents=True, exist_ok=True)

    shards: dict[str, dict] = defaultdict(dict)
    geo_features = []
    n_cells = 0
    for cell in grid.cells_for_bbox(bbox, level, max_cells=max_cells):
        data = counter(cell)
        scores = composite.compute_scores(data)
        values = [scores[f]["value"] for f in fields]

        code = cell["code"].replace("-", "")
        shards[code[:shard_prefix_len]][code] = values
        n_cells += 1

        if pmtiles:
            b = cell["bounds"]
            geo_features.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [[
                    [b["west"], b["south"]], [b["east"], b["south"]],
                    [b["east"], b["north"]], [b["west"], b["north"]], [b["west"], b["south"]],
                ]]},
                "properties": {"code": cell["code"], **{f: v for f, v in zip(fields, values)}},
            })

    # Clear any stale shards from a previous (finer) run, then write fresh.
    for old in region_dir.glob("*.json"):
        old.unlink()
    for prefix, obj in shards.items():
        (region_dir / f"{prefix}.json").write_text(json.dumps(obj, separators=(",", ":")))

    _write_coverage(out, region, level, bbox, fields, radius_m, shard_prefix_len,
                    sorted(shards.keys()))

    if pmtiles:
        _write_pmtiles(out, region, geo_features)

    return {"region": region, "level": level, "cells": n_cells,
            "shards": len(shards), "fields": len(fields)}


def _write_coverage(out: Path, region, level, bbox, fields, radius_m, shard_prefix_len, shard_prefixes):
    path = out / "coverage.json"
    try:
        cov = json.loads(path.read_text())
    except Exception:
        cov = {"version": SCHEMA_VERSION, "fields": fields, "regions": []}
    cov["version"] = SCHEMA_VERSION
    cov["generated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    cov["fields"] = fields
    cov["radiusM"] = radius_m
    entry = {"name": region, "level": level, "shardPrefixLen": shard_prefix_len,
             "shards": shard_prefixes, "bbox": bbox, "path": f"data/scores/{region}/"}
    cov["regions"] = [r for r in cov.get("regions", []) if r.get("name") != region] + [entry]
    path.write_text(json.dumps(cov, indent=2) + "\n")


def _write_pmtiles(out: Path, region, geo_features):
    from pipeline.geojson_to_pmtiles import convert
    gj_path = out / region / "_scores.geojson"
    gj_path.write_text(json.dumps({"type": "FeatureCollection", "features": geo_features}))
    convert(gj_path, out / region / "scores.pmtiles", layer_name="scores")
    gj_path.unlink()


def main(argv=None):
    p = argparse.ArgumentParser(description="Build the precomputed scored tile for a region.")
    p.add_argument("--region", default="indore_pilot")
    p.add_argument("--level", type=int, default=6)
    p.add_argument("--out", default="data/scores")
    p.add_argument("--pbf")
    p.add_argument("--pop")
    p.add_argument("--dem")
    p.add_argument("--radius-m", type=float, default=DEFAULT_RADIUS_M)
    p.add_argument("--shard-prefix-len", type=int, default=DEFAULT_SHARD_PREFIX_LEN)
    p.add_argument("--max-cells", type=int, default=None)
    p.add_argument("--pmtiles", action="store_true")
    a = p.parse_args(argv)
    summary = build(a.region, a.level, a.out, pbf=a.pbf, pop=a.pop, dem=a.dem,
                    radius_m=a.radius_m, shard_prefix_len=a.shard_prefix_len,
                    max_cells=a.max_cells, pmtiles=a.pmtiles)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
