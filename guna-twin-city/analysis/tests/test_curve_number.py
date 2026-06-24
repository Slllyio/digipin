"""Tests for the Curve Number engine (curve_number.py).

The CN engine is the single source of truth for SCS Curve Numbers in the
Guna flood model: a TR-55 land-use x Hydrologic-Soil-Group matrix plus the
standard Antecedent-Moisture-Condition (AMC) conversions.

References:
  - USDA NRCS TR-55 / National Engineering Handbook Part 630 ch.9-10
  - AMC-I conversion: Sobhani (1975)
  - AMC-III conversion: Hawkins et al. (1985)
"""
import pytest

import curve_number as cn

pytestmark = pytest.mark.unit


# ── AMC conversion formulas ────────────────────────────────────────────

def test_amc_i_textbook_value():
    # CN_II = 78  ->  CN_I ~= 59.8  (Sobhani 1975)
    assert cn.amc_i(78) == pytest.approx(59.8, abs=0.3)


def test_amc_iii_textbook_value():
    # CN_II = 78  ->  CN_III ~= 89.1  (Hawkins et al. 1985)
    assert cn.amc_iii(78) == pytest.approx(89.1, abs=0.3)


@pytest.mark.parametrize("cn_ii", [40, 55, 61, 72, 85, 92])
def test_amc_ordering(cn_ii):
    """Dry (I) < normal (II) < wet (III) for every curve number."""
    assert cn.amc_i(cn_ii) < cn_ii < cn.amc_iii(cn_ii)


def test_amc_endpoints_clamped_to_100():
    assert cn.amc_i(100) == pytest.approx(100, abs=1e-6)
    assert cn.amc_iii(100) == pytest.approx(100, abs=1e-6)
    assert cn.amc_iii(98) <= 100.0


# ── TR-55 CN table (land cover x HSG) ──────────────────────────────────

def test_table_covers_all_worldcover_classes():
    # ESA WorldCover classes used by the flood model
    for klass in (10, 20, 30, 40, 50, 60, 80, 90):
        assert klass in cn.CN_TABLE, f"missing WorldCover class {klass}"
        assert set(cn.CN_TABLE[klass]) >= {"A", "B", "C", "D"}


@pytest.mark.parametrize("klass", [10, 30, 40, 50, 60])
def test_cn_increases_with_soil_group(klass):
    """Runoff potential rises A < B < C < D for a fixed land cover."""
    a, b, c, d = (cn.CN_TABLE[klass][h] for h in ("A", "B", "C", "D"))
    assert a < b < c <= d


def test_builtup_higher_than_forest():
    # Built-up (50) must shed far more than tree cover (10) on the same soil
    assert cn.cn_for(50, "C") > cn.cn_for(10, "C")


def test_water_class_near_total_runoff():
    assert cn.cn_for(80, "B") >= 98


def test_cn_for_applies_amc():
    base = cn.cn_for(50, "C", amc="II")
    assert cn.cn_for(50, "C", amc="I") < base < cn.cn_for(50, "C", amc="III")


def test_cn_for_unknown_class_uses_documented_default():
    # Unknown class falls back to a documented mid default, never crashes
    val = cn.cn_for(999, "C")
    assert 0 < val <= 100


# ── area-weighted CN ───────────────────────────────────────────────────

def test_weighted_cn_single_cell_class():
    counts = {(50, "C"): 100}
    assert cn.weighted_cn(counts, amc="II") == pytest.approx(cn.cn_for(50, "C", "II"))


def test_weighted_cn_mixed_is_area_average():
    counts = {(50, "C"): 30, (10, "C"): 70}
    expected = (cn.cn_for(50, "C") * 30 + cn.cn_for(10, "C") * 70) / 100
    assert cn.weighted_cn(counts, amc="II") == pytest.approx(expected)


def test_weighted_cn_empty_returns_documented_default():
    assert cn.weighted_cn({}, amc="II") == pytest.approx(cn.DEFAULT_CN)
