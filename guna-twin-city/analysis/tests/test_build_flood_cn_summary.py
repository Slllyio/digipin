"""Tests for the flood CN summary assembly (build_flood_cn_summary.summarize_cn).

Pure-logic tests on synthetic LULC + HSG arrays; the raster I/O in build() is
exercised separately by running the script on the real Guna rasters.
"""
import pytest

np = pytest.importorskip("numpy")

import build_flood_cn_summary as bld
import curve_number as cn

pytestmark = pytest.mark.unit


def test_uniform_builtup_hsg_d():
    lulc = np.full((4, 4), 50)        # all built-up
    hsg_codes = np.full((4, 4), 4)    # all HSG D
    s = bld.summarize_cn(lulc, hsg_codes, rainfall_mm=328.0)

    assert s["weighted_cn"]["amc_ii"] == pytest.approx(cn.cn_for(50, "D", "II"), abs=0.1)
    band = s["runoff_band_mm"]
    assert band["amc_i"] < band["amc_ii"] < band["amc_iii"]   # dry < normal < wet
    assert s["hsg_distribution_pct"] == {"D": 100.0}
    assert s["lulc_distribution_pct"]["Built-up"] == 100.0


def test_mixed_classes_area_weighted():
    lulc = np.array([[50, 50], [10, 10]])   # half built-up, half tree cover
    hsg_codes = np.full((2, 2), 3)          # HSG C
    s = bld.summarize_cn(lulc, hsg_codes)
    expected = (cn.cn_for(50, "C") + cn.cn_for(10, "C")) / 2
    assert s["weighted_cn"]["amc_ii"] == pytest.approx(round(expected, 1), abs=0.1)


def test_ignores_nodata_classes():
    lulc = np.array([[50, 0], [255, 50]])   # 0 / 255 are nodata, not in CN_TABLE
    hsg_codes = np.full((2, 2), 4)
    s = bld.summarize_cn(lulc, hsg_codes)
    assert s["lulc_distribution_pct"] == {"Built-up": 100.0}


def test_ia_sensitivity_modern_ge_legacy():
    lulc = np.full((3, 3), 40)              # cropland
    hsg_codes = np.full((3, 3), 3)          # HSG C
    s = bld.summarize_cn(lulc, hsg_codes)
    assert set(s["ia_sensitivity_mm"]) == {"ia_0.05", "ia_0.2"}
    # Modern Ia=0.05 never under-estimates runoff vs the legacy 0.2.
    assert s["ia_sensitivity_mm"]["ia_0.05"] >= s["ia_sensitivity_mm"]["ia_0.2"]


def test_runoff_ratio_band_bounded():
    lulc = np.full((3, 3), 30)
    hsg_codes = np.full((3, 3), 2)
    s = bld.summarize_cn(lulc, hsg_codes)
    for v in s["runoff_ratio_band"].values():
        assert 0.0 <= v <= 1.0
