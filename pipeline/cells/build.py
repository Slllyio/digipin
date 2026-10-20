"""Build the cell store's built-in datasets from what the pipeline already made.

    python -m pipeline.cells.build --region indore_pilot            # all
    python -m pipeline.cells.build --region indore_pilot traffic    # one
    python -m pipeline.cells.build --no-parquet                     # JSON only

Each entry in ``BUILTINS`` pairs a DatasetSpec (the registry entry the frontend
renders from) with a reader over existing pipeline output. Adding a dataset is
one entry here — or, for an ad-hoc CSV/GeoJSON, ``python -m pipeline.cells.ingest``.
Missing inputs are skipped with a note, so a partial checkout still builds.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline.cells import adapters, store
from pipeline.cells.schema import DatasetSpec, FieldSpec

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "data"

# Score ids where a high value is bad (red = high). Everything else: high = good.
_SCORES_WORSE = {"flood_risk"}
_LOS_COLORS = {"A": "#31a354", "B": "#fdbb84", "C": "#fc8d59",
               "D": "#ef6548", "E": "#d7301f", "F": "#7f0000"}
_ACCESS_COLORS = {"Smooth": "#31a354", "Constrained": "#fdae61", "Restricted": "#d7191c"}


def _score_labels() -> dict:
    from pipeline.scores import composite
    return {k: v["label"] for k, v in composite.compute_scores({}).items()}


def build_scores(region: str):
    root = DATA / "scores"
    if not (root / "coverage.json").exists():
        return None
    fields, records = adapters.score_shard_records(root, region)
    level = next(r["level"] for r in json.loads((root / "coverage.json").read_text())["regions"]
                 if r["name"] == region)
    labels = _score_labels()
    specs = [FieldSpec(key=k, label=labels.get(k, k), agg="mean", unit="0-100",
                       domain=[0, 100], ramp="reds" if k in _SCORES_WORSE else "viridis",
                       higher_is="worse" if k in _SCORES_WORSE else "better")
             for k in fields]
    spec = DatasetSpec(
        id="scores", title="Intelligence scores",
        description="~20 composite urban scores (walkability, livability, flood risk…) "
                    "precomputed per cell from a bulk OSM extract.",
        source="pipeline/scores/build_tile.py", license="ODbL (OpenStreetMap)",
        level=level, fields=specs, default_field="livability", height_m=600)
    return spec, store.bin_records(records, level, specs)


def build_traffic(region: str, level: int = 7):
    p = DATA / "traffic" / region / "traffic_grid.json"
    if not p.exists():
        return None
    grid = json.loads(p.read_text())
    specs = [
        FieldSpec("congestion_risk", "Congestion risk", agg="max", unit="0-100",
                  domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("worst_los", "Worst level of service", type="category", agg="max",
                  colors=_LOS_COLORS),
        FieldSpec("dominant_class", "Dominant road class", type="category", agg="mode"),
        FieldSpec("road_density_m", "Road length per 200 m pixel", agg="mean", unit="m",
                  ramp="blues"),
        FieldSpec("has_critical_link", "Has a critical link", type="boolean", agg="any"),
        FieldSpec("transit_stops", "Transit stops", agg="sum", unit="count", ramp="greens",
                  higher_is="better"),
        FieldSpec("transit_access", "Transit access", agg="max", unit="0-100",
                  domain=[0, 100], ramp="greens", higher_is="better"),
    ]
    keys = [f.key for f in specs]
    # Only pixels with a road or a stop — keeps the store sparse (~5% of the bbox).
    records = adapters.grid_records(
        grid, keys, keep=lambda r: r.get("dominant_class") is not None or (r.get("transit_stops") or 0) > 0)
    spec = DatasetSpec(
        id="traffic", title="Traffic congestion (structural)",
        description="Road-network betweenness → level-of-service per cell. Structural "
                    "congestion, not live delays (docs/TRAFFIC_MODEL.md).",
        source="pipeline/traffic/traffic_grid.py", license="ODbL (OpenStreetMap)",
        level=level, fields=specs, default_field="congestion_risk", height_m=300)
    return spec, store.bin_records(records, level, specs)


def build_mobility(region: str, level: int = 7):
    p = DATA / "safety" / region / "mobility_grid.json"
    if not p.exists():
        return None
    grid = json.loads(p.read_text())
    specs = [
        FieldSpec("mobility_risk", "Mobility risk", agg="max", unit="0-100",
                  domain=[0, 100], ramp="reds", higher_is="worse"),
        FieldSpec("access_class", "Access class", type="category", agg="mode",
                  colors=_ACCESS_COLORS),
        FieldSpec("sealable", "In a sealable pocket", type="boolean", agg="any"),
        FieldSpec("on_chokepoint", "On a chokepoint", type="boolean", agg="any"),
        FieldSpec("nearest_police_km", "Nearest police station", agg="min", unit="km",
                  ramp="reds", higher_is="worse"),
    ]
    keys = [f.key for f in specs]
    records = adapters.grid_records(grid, keys, keep=lambda r: r.get("mobility_risk") is not None)
    spec = DatasetSpec(
        id="mobility", title="Law & order mobility",
        description="Where emergency movement can be choked or sealed off "
                    "(docs/MOBILITY_MODEL.md).",
        source="pipeline/safety/mobility.py", license="ODbL (OpenStreetMap)",
        level=level, fields=specs, default_field="mobility_risk", height_m=300)
    return spec, store.bin_records(records, level, specs)


BUILTINS = {"scores": build_scores, "traffic": build_traffic, "mobility": build_mobility}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Build the per-DIGIPIN-cell data store.")
    p.add_argument("datasets", nargs="*", help=f"subset of {sorted(BUILTINS)} (default: all)")
    p.add_argument("--region", default="indore_pilot")
    p.add_argument("--out", default=str(DATA / "cells"))
    p.add_argument("--no-parquet", action="store_true", help="skip GeoParquet (no pyarrow needed)")
    a = p.parse_args(argv)

    unknown = set(a.datasets) - set(BUILTINS)
    if unknown:
        p.error(f"unknown dataset(s) {sorted(unknown)}; known: {sorted(BUILTINS)}")
    for name in a.datasets or list(BUILTINS):
        built = BUILTINS[name](a.region)
        if built is None:
            print(json.dumps({"dataset": name, "region": a.region, "skipped": "input missing"}))
            continue
        spec, table = built
        print(json.dumps(store.write_dataset(a.out, spec, a.region, table, parquet=not a.no_parquet)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
