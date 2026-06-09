"""Tests for the grid-scoring orchestrator (pipeline/scores/score_grid.py).

Exercises the wiring (enumerate -> count -> score -> flat record) with stub
feature counters, so it stays pure and data-free.
"""
from __future__ import annotations

from pipeline.scores import composite, score_grid

BBOX = {"south": 22.71, "north": 22.73, "west": 75.85, "east": 75.87}
LEVEL = 6


def test_one_record_per_cell_with_all_score_columns():
    from pipeline._lib import grid

    cells = grid.cells_for_bbox(BBOX, LEVEL)
    rows = score_grid.score_grid(BBOX, LEVEL)
    assert len(rows) == len(cells)

    expected_cols = set(score_grid.score_field_names())
    for row in rows:
        assert {"code", "lat", "lng"} <= set(row)
        assert expected_cols <= set(row)
        # Every score is an integer 0..100.
        for col in expected_cols:
            assert isinstance(row[col], int) and 0 <= row[col] <= 100


def test_empty_counter_matches_baseline_compute_scores():
    rows = score_grid.score_grid(BBOX, LEVEL)
    baseline = {k: v["value"] for k, v in composite.compute_scores({}).items()}
    for row in rows:
        for col, val in baseline.items():
            assert row[col] == val


def test_feature_counter_changes_scores():
    """A counter that injects parks must lift the green score above baseline."""
    def parky(cell):
        return {"categories": {"leisure": {"features": {"parks": {"count": 12}}}}}

    rows = score_grid.score_grid(BBOX, LEVEL, count_features=parky)
    baseline_green = composite.compute_scores({})["green"]["value"]
    assert rows, "expected cells"
    assert all(row["green"] > baseline_green for row in rows)


def test_codes_are_unique_across_the_grid():
    rows = score_grid.score_grid(BBOX, LEVEL)
    codes = [row["code"] for row in rows]
    assert len(codes) == len(set(codes))


def test_max_cells_propagates():
    import pytest

    with pytest.raises(ValueError):
        score_grid.score_grid(BBOX, LEVEL, max_cells=1)


def test_score_field_names_are_stable_and_complete():
    names = score_grid.score_field_names()
    assert "livability" in names and "flood_risk" in names and "walkability" in names
    assert len(names) == len(set(names))


def test_geojson_is_a_valid_feature_collection_of_cell_polygons():
    import json

    from pipeline._lib import grid

    fc = score_grid.score_grid_geojson(BBOX, LEVEL)
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == len(grid.cells_for_bbox(BBOX, LEVEL))
    json.dumps(fc)  # must be serialisable

    expected_cols = set(score_grid.score_field_names())
    for feat in fc["features"]:
        assert feat["type"] == "Feature"
        assert feat["geometry"]["type"] == "Polygon"
        ring = feat["geometry"]["coordinates"][0]
        assert len(ring) == 5 and ring[0] == ring[-1]      # closed rectangle
        props = feat["properties"]
        assert "code" in props
        assert expected_cols <= set(props)


def test_geojson_polygon_matches_the_cell_bounds():
    from pipeline._lib import grid

    cells = {c["code"]: c for c in grid.cells_for_bbox(BBOX, LEVEL)}
    for feat in score_grid.score_grid_geojson(BBOX, LEVEL)["features"]:
        b = cells[feat["properties"]["code"]]["bounds"]
        lons = [pt[0] for pt in feat["geometry"]["coordinates"][0]]
        lats = [pt[1] for pt in feat["geometry"]["coordinates"][0]]
        assert min(lons) == b["west"] and max(lons) == b["east"]
        assert min(lats) == b["south"] and max(lats) == b["north"]
