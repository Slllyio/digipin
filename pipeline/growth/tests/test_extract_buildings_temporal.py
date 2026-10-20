"""Smoke test for the buildings-temporal extractor.

Doesn't hit GEE (would need credentials in CI). Just verifies the
module imports cleanly and constants are sane.
"""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.growth.extract_buildings_temporal")
    assert hasattr(mod, "main")
    assert hasattr(mod, "INDIA_BBOX")
    assert hasattr(mod, "YEARS")


def test_india_bbox_is_sensible():
    from pipeline.growth.extract_buildings_temporal import INDIA_BBOX
    # INDIA_BBOX is region-aware (defaults to Indore pilot via
    # pipeline._lib.regions.get_default_bbox). Sanity-check: ordering
    # is correct AND coordinates fall inside the Indian subcontinent.
    west, south, east, north = INDIA_BBOX
    assert west < east
    assert south < north
    assert 60 < west < 98       # within Indian lng span
    assert 5 < south < 36       # within Indian lat span


def test_year_range():
    from pipeline.growth.extract_buildings_temporal import YEARS
    assert YEARS[0] == 2016
    assert YEARS[-1] == 2023
    assert len(YEARS) == 8
