"""Unit tests for the batch tile driver (no network).

The download/clip/build chain needs Geofabrik + the osmium CLI, so it is not
exercised here; the DEM mosaic path is verified live against Copernicus S3
during real builds. These cover the pure routing/validation logic.
"""
from __future__ import annotations

import pytest

from pipeline._lib import regions
from pipeline.scores import build_cities


def test_group_by_zone_covers_all_pilots_once():
    grouped = build_cities.group_by_zone(list(regions.CITY_PILOTS))
    flat = [c for cities in grouped.values() for c in cities]
    # every pilot appears exactly once, partitioned across its zone
    assert sorted(flat) == sorted(regions.CITY_PILOTS)
    assert "indore_pilot" in grouped["central-zone"]
    assert set(grouped["western-zone"]) == {"pune", "mumbai"}


def test_group_by_zone_subset():
    grouped = build_cities.group_by_zone(["bhopal", "delhi"])
    assert grouped == {"central-zone": ["bhopal"], "northern-zone": ["delhi"]}


def test_main_rejects_unknown_region():
    with pytest.raises(SystemExit):
        build_cities.main(["atlantis"])


def test_main_rejects_national_fallback():
    # india_full has no Geofabrik zone — must be refused, not silently skipped.
    with pytest.raises(SystemExit):
        build_cities.main(["india_full"])
