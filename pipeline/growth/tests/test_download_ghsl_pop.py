"""Smoke test for the GHSL exporter.

Doesn't actually hit GEE (would need credentials in CI). Verifies module
imports and that key constants are sane.

History note: previously asserted on GHSL_URL — the original spec called
for an HTTPS download from jeodpp.jrc.ec.europa.eu, but that URL pattern
moved in the R2025A release. We switched to the GEE-mirrored asset.
"""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.growth.download_ghsl_pop")
    assert hasattr(mod, "main")
    assert hasattr(mod, "ASSET_ID_PREFIX")
    assert hasattr(mod, "YEAR")
    assert hasattr(mod, "INDIA_BBOX")
    assert hasattr(mod, "OUTPUT_PATH")


def test_asset_id_prefix_targets_ghsl_p2023a():
    from pipeline.growth.download_ghsl_pop import ASSET_ID_PREFIX
    assert ASSET_ID_PREFIX == "JRC/GHSL/P2023A/GHS_POP"


def test_year_is_supported_ghsl_epoch():
    from pipeline.growth.download_ghsl_pop import YEAR
    # GHSL on GEE: 1975, 1980, 1985, ..., 2020 (5-year intervals)
    assert YEAR in {1975, 1980, 1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020}


def test_output_path_matches_year():
    from pipeline.growth.download_ghsl_pop import OUTPUT_PATH, YEAR
    path = str(OUTPUT_PATH).replace("\\", "/")
    # Output path includes a region tag (Week 3 perf scoping) so the
    # same year can ship multiple regions side-by-side.
    assert f"ghsl_pop_{YEAR}_" in path
    assert path.endswith(".tif")


def test_india_bbox_sane():
    # INDIA_BBOX is region-aware (defaults to Indore pilot). See
    # pipeline._lib.regions.get_default_bbox.
    from pipeline.growth.download_ghsl_pop import INDIA_BBOX
    west, south, east, north = INDIA_BBOX
    assert west < east and south < north
    assert 60 < west < 98 and 5 < south < 36
