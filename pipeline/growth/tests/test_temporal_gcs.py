"""Pure-logic tests for the no-GEE temporal building-change pipeline.

Network (GCS manifest fetch) and the bulk raster build are not exercised here;
those run in a data-capable environment. We test the geometry/parse helpers.
"""
import pytest

mod = pytest.importorskip(
    "pipeline.growth.download_temporal_gcs",
    reason="needs s2sphere + rasterio",
)
pytest.importorskip("rasterio")


def test_epsg_parsed_from_manifest_name():
    assert mod._epsg_from_name("v1/manifests/3b_EPSG_32643_2020_06_30.json") == 32643
    assert mod._epsg_from_name("v1/manifests/39_EPSG_32642_2016_06_30.json") == 32642


def test_intersects_bbox():
    indore = (75.6, 22.5, 76.0, 22.9)
    assert mod._intersects((75.7, 22.6, 75.9, 22.8), indore)      # inside
    assert mod._intersects((75.5, 22.4, 75.7, 22.6), indore)      # overlaps corner
    assert not mod._intersects((74.0, 21.0, 74.5, 21.5), indore)  # disjoint west
    assert not mod._intersects((76.5, 23.0, 77.0, 23.5), indore)  # disjoint NE


def test_tile_wgs84_bounds_maps_utm_into_indore():
    # A 12.5 km, 0.5 m tile in UTM 43N near Indore should yield a WGS84 bbox
    # that lands in the ~75-76°E / 22-23°N range.
    # UTM 43N (EPSG:32643): zone central meridian 75°E → easting 500000.
    # ~560000 E / ~2530000 N is the Indore area; the tile is 12.5 km square.
    source = {
        "affineTransform": {"scaleX": 0.5, "translateX": 560000.0,
                            "scaleY": -0.5, "translateY": 2530000.0},
        "dimensions": {"width": 25000, "height": 25000},
    }
    w, s, e, n = mod.tile_wgs84_bounds(source, 32643)
    assert 75.0 < w < 76.0 and 75.0 < e < 76.0
    assert 22.0 < s < 23.5 and 22.0 < n < 23.5
    assert w < e and s < n


def test_s2_tokens_for_indore_are_level2():
    toks = mod.s2_tokens((75.6, 22.5, 76.0, 22.9))
    assert set(toks) == {"39", "3b"}      # verified against the live bucket
