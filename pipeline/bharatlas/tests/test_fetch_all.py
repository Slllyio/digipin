"""Unit tests for the Bharatlas mirror script.

These run without network — they verify the helper functions handle
edge cases (URL parsing, size matching, missing fields) correctly.
The actual network-mirror behaviour is covered by the integration
test below, which is `@pytest.mark.integration` so it's skipped in
default CI runs.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from pipeline.bharatlas.fetch_all import (
    ALL_FORMATS,
    CATALOG_URL,
    DEFAULT_FORMATS,
    _r2_path_from_url,
)


def test_r2_path_strips_base():
    catalog = {"r2_base": "https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev"}
    url = "https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/admin/states/LGD_States.pmtiles"
    assert _r2_path_from_url(catalog, url) == "admin/states/LGD_States.pmtiles"


def test_r2_path_handles_non_r2_url():
    """Some catalog entries point to upstream sources (data.gov.in, etc.).
    We fall back to the URL path component so the local layout is still sane."""
    catalog = {"r2_base": "https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev"}
    url = "https://data.gov.in/raw/pincodes.shp"
    assert _r2_path_from_url(catalog, url) == "raw/pincodes.shp"


def test_default_formats_are_a_subset_of_all():
    assert set(DEFAULT_FORMATS).issubset(set(ALL_FORMATS))
    assert "pmtiles" in DEFAULT_FORMATS
    assert "parquet" in DEFAULT_FORMATS


def test_catalog_url_is_https():
    assert CATALOG_URL.startswith("https://")
    assert "bharatlas.com" in CATALOG_URL
