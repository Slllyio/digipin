"""Contract tests for pipeline._lib.regions.

The Indore pilot default is load-bearing — every GEE pipeline script
imports get_default_bbox() and ships a COG sized accordingly. A bad
override here would produce 1500× too-large COGs.
"""

from __future__ import annotations

import importlib
import os
import pytest

from pipeline._lib import regions


def test_indore_pilot_is_within_indore_metropolitan_area():
    # ~22.5-22.9°N, 75.6-76.0°E — Indore municipal + Pithampur.
    west, south, east, north = regions.INDORE_PILOT
    assert west < east
    assert south < north
    # Indore city centroid ~22.72°N, 75.86°E — must be inside the bbox.
    assert west <= 75.86 <= east
    assert south <= 22.72 <= north


def test_india_full_covers_mainland_extremes():
    west, south, east, north = regions.INDIA_FULL
    # Mumbai (~72.87°E, 19.07°N)
    assert west <= 72.87 <= east
    assert south <= 19.07 <= north
    # Itanagar (~93.61°E, 27.10°N) — easternmost mainland capital
    assert west <= 93.61 <= east
    assert south <= 27.10 <= north


def test_default_is_indore_pilot(monkeypatch):
    monkeypatch.delenv("DIGIPIN_REGION", raising=False)
    importlib.reload(regions)
    assert regions.get_default_bbox() == regions.INDORE_PILOT
    assert regions.get_default_region_name() == "indore_pilot"


def test_override_to_india_full(monkeypatch):
    monkeypatch.setenv("DIGIPIN_REGION", "india_full")
    importlib.reload(regions)
    assert regions.get_default_bbox() == regions.INDIA_FULL


def test_unknown_region_raises(monkeypatch):
    monkeypatch.setenv("DIGIPIN_REGION", "atlantis")
    importlib.reload(regions)
    with pytest.raises(ValueError, match="unknown DIGIPIN_REGION"):
        regions.get_default_bbox()
