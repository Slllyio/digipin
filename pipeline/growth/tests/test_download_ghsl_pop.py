"""Smoke test for the GHSL downloader.

Doesn't actually hit jeodpp.jrc.ec.europa.eu (it's a 500 MB download).
Verifies module imports and that key constants are sane.
"""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.growth.download_ghsl_pop")
    assert hasattr(mod, "main")
    assert hasattr(mod, "GHSL_URL")
    assert hasattr(mod, "INDIA_BBOX")
    assert hasattr(mod, "OUTPUT_PATH")


def test_url_targets_2025_epoch():
    from pipeline.growth.download_ghsl_pop import GHSL_URL
    assert "E2025" in GHSL_URL or "2025" in GHSL_URL


def test_output_path_in_data_growth():
    from pipeline.growth.download_ghsl_pop import OUTPUT_PATH
    assert str(OUTPUT_PATH).replace("\\", "/").endswith("data/growth/ghsl_pop_2025.tif")


def test_india_bbox_sane():
    from pipeline.growth.download_ghsl_pop import INDIA_BBOX
    west, south, east, north = INDIA_BBOX
    assert west < east and south < north
    assert 60 < west < 80 and 5 < south < 15
