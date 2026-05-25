"""Smoke test for the MODIS LST extractor.

Doesn't hit GEE (would consume real quota + take 10+ min). Verifies the
module imports cleanly and constants are sane — same pattern as the
pipeline/growth/tests/ extractors.
"""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.heat.extract_modis_lst")
    assert hasattr(mod, "main")
    assert hasattr(mod, "INDIA_BBOX")
    assert hasattr(mod, "YEARS")
    assert hasattr(mod, "ASSET_ID")
    assert hasattr(mod, "OUTPUT_PATH")


def test_asset_id_targets_modis_collection_061():
    from pipeline.heat.extract_modis_lst import ASSET_ID
    assert ASSET_ID == "MODIS/061/MOD11A1"


def test_year_range_matches_viirs():
    """The heat pipeline shares the VIIRS year range so downstream
    consumers can do straightforward year-aligned comparisons."""
    from pipeline.heat.extract_modis_lst import YEARS
    assert YEARS[0] == 2016
    assert YEARS[-1] == 2024
    assert len(YEARS) == 9


def test_output_path():
    from pipeline.heat.extract_modis_lst import OUTPUT_PATH
    path = str(OUTPUT_PATH).replace("\\", "/")
    assert path.endswith("data/heat/modis_lst_2016-2024.tif")


def test_india_bbox():
    from pipeline.heat.extract_modis_lst import INDIA_BBOX
    west, south, east, north = INDIA_BBOX
    assert west < east and south < north
    assert 60 < west < 80 and 5 < south < 15


def test_scale_is_modis_native():
    from pipeline.heat.extract_modis_lst import SCALE_M
    # MODIS LST 1km product — anything else is a bug
    assert SCALE_M == 1000
