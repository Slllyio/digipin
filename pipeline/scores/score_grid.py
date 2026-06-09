"""Score an analysis grid — the Phase 0 step-1 orchestrator.

Ties the cell enumerator (pipeline/_lib/grid.py) to the composite score model
(composite.py): for every DIGIPIN cell in a bbox, count its OSM features, run
the scorers, and emit one flat record per cell — the shape that becomes the
GeoParquet/PMTiles tile (docs/PRECOMPUTE_PLAN.md).

The seam that stays data-dependent is the **feature counter**: a callable that,
given a cell, returns the ``data`` dict ``compute_scores`` expects
(``{"categories": {...}, "environment": {...}}``). In production this is an
``osmium``/DuckDB query against a bulk ``.osm.pbf`` extract (no per-click
Overpass calls); the contract is documented below and exercised with a stub in
tests. Growth/heat scores come from the raster pipelines (Phase 2), not here.
"""
from __future__ import annotations

from typing import Callable, Optional

from pipeline._lib import grid
from pipeline.scores import composite

# A FeatureCounter takes a cell dict ({"code", "bounds", "center"}) and returns
# the data dict compute_scores consumes. Returning {} yields baseline scores.
FeatureCounter = Callable[[dict], dict]


def empty_feature_counter(cell: dict) -> dict:
    """Reference counter: no features anywhere (every cell scores from zero)."""
    return {}


def score_grid(
    bbox: dict,
    level: int,
    count_features: FeatureCounter = empty_feature_counter,
    max_cells: Optional[int] = None,
) -> list:
    """Return one flat score record per DIGIPIN cell intersecting ``bbox``.

    Each record: {"code", "lat", "lng", <score_id>: value, ...} with the ~24
    composite intelligence scores flattened to their integer values.
    """
    rows = []
    for cell in grid.cells_for_bbox(bbox, level, max_cells=max_cells):
        data = count_features(cell)
        scores = composite.compute_scores(data)
        row = {
            "code": cell["code"],
            "lat": cell["center"]["lat"],
            "lng": cell["center"]["lng"],
        }
        for score_id, score in scores.items():
            row[score_id] = score["value"]
        rows.append(row)
    return rows


def score_field_names() -> list:
    """The score columns a record carries, in model order — for tile schemas."""
    return list(composite.compute_scores({}).keys())
