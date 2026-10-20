"""Pure-logic tests for the footprint-density grid aggregation."""
import pytest

mod = pytest.importorskip("pipeline.buildings.footprint_grid")


def test_bins_footprints_into_correct_cells():
    bbox = (75.6, 22.5, 76.0, 22.9)   # w,s,e,n
    feats = [
        {"lat": 22.55, "lng": 75.65, "area": 100},   # SW corner cell
        {"lat": 22.55, "lng": 75.65, "area": 200},   # same cell
        {"lat": 22.85, "lng": 75.95, "area": 50},     # NE area
        {"lat": 10.0, "lng": 10.0, "area": 999},      # outside bbox → ignored
    ]
    g = mod.bin_footprints(feats, bbox, res_m=1000)
    assert g["nx"] > 0 and g["ny"] > 0
    assert sum(g["count"]) == 3                       # the out-of-bbox one dropped
    # the two co-located footprints land in one cell with mean area (100+200)/2
    assert 150.0 in g["meanAreaM2"]
    # coverage is a percentage 0..100
    assert all(0 <= c <= 100 for c in g["coveragePct"])


def test_empty_input_yields_zeroed_grid():
    g = mod.bin_footprints([], (75.6, 22.5, 76.0, 22.9), res_m=1000)
    assert sum(g["count"]) == 0
    assert g["bounds"]["west"] == 75.6


def test_row0_is_north():
    # a northern footprint should map to a small y index (top of the grid)
    bbox = (75.6, 22.5, 76.0, 22.9)
    g = mod.bin_footprints([{"lat": 22.89, "lng": 75.61, "area": 10}], bbox, res_m=1000)
    idx = next(i for i, c in enumerate(g["count"]) if c > 0)
    y = idx // g["nx"]
    assert y <= 1   # near the top (north) row
