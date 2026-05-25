"""Smoke test for the VIIRS annual extractor."""

import importlib


def test_module_imports():
    mod = importlib.import_module("pipeline.growth.extract_viirs_annual")
    assert hasattr(mod, "main")
    assert hasattr(mod, "YEARS")


def test_year_range():
    from pipeline.growth.extract_viirs_annual import YEARS
    assert YEARS[0] == 2016
    assert YEARS[-1] == 2024
    assert len(YEARS) == 9
