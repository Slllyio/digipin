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
    # west, south, east, north
    assert INDIA_BBOX[0] < INDIA_BBOX[2]    # west < east
    assert INDIA_BBOX[1] < INDIA_BBOX[3]    # south < north
    assert 60 < INDIA_BBOX[0] < 80          # India is in this lng range
    assert 5 < INDIA_BBOX[1] < 15           # southern tip


def test_year_range():
    from pipeline.growth.extract_buildings_temporal import YEARS
    assert YEARS[0] == 2016
    assert YEARS[-1] == 2023
    assert len(YEARS) == 8
