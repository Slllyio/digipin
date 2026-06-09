"""Tests for the DIGIPIN analysis-grid enumerator (pipeline/_lib/grid.py).

New pipeline logic (no JS counterpart), so these assert the properties a grid
must have: full coverage of the bbox, no duplicates, cells contained in India
and consistent with their own codes.
"""
from __future__ import annotations

import pytest

from pipeline._lib import digipin, grid

# ~2 km box over central Indore.
BBOX = {"south": 22.71, "north": 22.73, "west": 75.85, "east": 75.87}
LEVEL = 6


def _stripped(cells):
    return {c["code"].replace("-", "") for c in cells}


def test_returns_cells_with_correct_level_and_no_duplicates():
    cells = grid.cells_for_bbox(BBOX, LEVEL)
    assert cells, "expected at least one cell"
    codes = _stripped(cells)
    assert len(codes) == len(cells), "duplicate codes returned"
    assert all(len(code) == LEVEL for code in codes)


def test_count_helper_matches_materialised_count():
    assert grid.count_cells_for_bbox(BBOX, LEVEL) == len(grid.cells_for_bbox(BBOX, LEVEL))


def test_every_point_in_bbox_is_covered_by_a_returned_cell():
    cells = grid.cells_for_bbox(BBOX, LEVEL)
    codes = _stripped(cells)
    # Sample a 5x5 lattice of interior points; each must fall in a returned cell.
    for i in range(1, 6):
        lat = BBOX["south"] + (BBOX["north"] - BBOX["south"]) * i / 6
        for j in range(1, 6):
            lon = BBOX["west"] + (BBOX["east"] - BBOX["west"]) * j / 6
            code = digipin.encode(lat, lon).replace("-", "")[:LEVEL]
            assert code in codes, f"point {lat},{lon} -> {code} not covered"


def test_cell_centers_lie_within_their_own_bounds_and_india():
    b = digipin.BOUNDS
    for cell in grid.cells_for_bbox(BBOX, LEVEL):
        bounds, center = cell["bounds"], cell["center"]
        assert bounds["south"] <= center["lat"] <= bounds["north"]
        assert bounds["west"] <= center["lng"] <= bounds["east"]
        assert b["minLat"] <= center["lat"] <= b["maxLat"]
        assert b["minLon"] <= center["lng"] <= b["maxLon"]


def test_finer_level_yields_more_cells():
    assert grid.count_cells_for_bbox(BBOX, 7) > grid.count_cells_for_bbox(BBOX, 6)


def test_degenerate_and_out_of_india_bboxes_return_empty():
    assert grid.cells_for_bbox({"south": 22.73, "north": 22.71, "west": 75.85, "east": 75.87}, LEVEL) == []
    assert grid.cells_for_bbox({"south": 50, "north": 55, "west": 10, "east": 20}, LEVEL) == []


def test_max_cells_guard_raises():
    with pytest.raises(ValueError):
        grid.cells_for_bbox(BBOX, LEVEL, max_cells=1)


def test_invalid_level_rejected():
    with pytest.raises(ValueError):
        grid.cells_for_bbox(BBOX, 11)
