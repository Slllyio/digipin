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


# ── Phase 1 multi-city registry ──────────────────────────────────────────────

def test_every_city_pilot_has_a_bbox_and_extract():
    assert "indore_pilot" in regions.CITY_PILOTS
    for city in regions.CITY_PILOTS:
        w, s, e, n = regions.bbox_for(city)
        assert w < e and s < n, f"{city} bbox not ordered"
        url = regions.geofabrik_url(city)
        assert url.startswith("https://download.geofabrik.de/asia/india/")
        assert url.endswith("-latest.osm.pbf")


def test_known_city_centroids_fall_in_their_bbox():
    centroids = {
        "bhopal": (77.41, 23.25), "pune": (73.86, 18.52), "mumbai": (72.88, 19.08),
        "bengaluru": (77.59, 12.97), "hyderabad": (78.47, 17.39),
        "chennai": (80.27, 13.08), "delhi": (77.21, 28.61),
    }
    for city, (lon, lat) in centroids.items():
        w, s, e, n = regions.bbox_for(city)
        assert w <= lon <= e and s <= lat <= n, f"{city} centroid outside bbox"


def test_clip_bbox_buffers_the_region():
    # ~1 km (0.01°) buffer on every side; matches the Indore value the workflow
    # used to hardcode (75.59,22.49,76.01,22.91).
    assert regions.clip_bbox_str("indore_pilot") == "75.5900,22.4900,76.0100,22.9100"


def test_dem_tiles_cover_the_bbox_corners():
    # Delhi spans the 77°E meridian → two 1°×1° GLO-30 tiles.
    tiles = regions.dem_tiles_for("delhi")
    assert (28, 76) in tiles and (28, 77) in tiles
    # Indore's core sits in N22/E075; the ~1 km buffer nudges its east edge
    # past 76°E, so edge cells also need N22/E076 — both are returned.
    assert regions.dem_tiles_for("indore_pilot") == [(22, 75), (22, 76)]
    for url in regions.dem_tile_urls("delhi"):
        assert url.startswith("https://copernicus-dem-30m.s3.amazonaws.com/")
        assert url.endswith(".tif")


def test_geofabrik_url_rejects_national_fallback():
    with pytest.raises(ValueError, match="no Geofabrik extract"):
        regions.geofabrik_url("india_full")
