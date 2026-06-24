"""Python port of the HeatScore model (js/heat-score.js).

Phase 0 of docs/PRECOMPUTE_PLAN.md — see pipeline/scores/README.md for the
golden-file parity pattern. Faithful, side-effect-free port; pinned to the JS
output by tests/test_heat_parity.py.
"""
from __future__ import annotations

from typing import Optional

from pipeline.scores.growth import js_round

__all__ = ["lst_raw_to_celsius", "uhi_score", "diurnal_range_c", "night_trend"]


def lst_raw_to_celsius(raw) -> Optional[float]:
    """MODIS LST raw uint16 (Kelvin x 50) to Celsius; 0 is the no-data sentinel."""
    if raw is None or raw == 0:
        return None
    return (raw / 50) - 273.15


def uhi_score(d: dict) -> Optional[int]:
    """Urban Heat Island score 0..100 from night-LST anomaly vs surroundings."""
    cell = d.get("cell_night_lst_c")
    surrounding = d.get("surrounding_night_lst_c")
    if cell is None or surrounding is None:
        return None
    anomaly = cell - surrounding
    return max(0, min(100, js_round((anomaly + 2) * 12)))


def diurnal_range_c(d: dict) -> Optional[float]:
    """Day LST minus night LST in Celsius."""
    day = d.get("day_lst_c")
    night = d.get("night_lst_c")
    if day is None or night is None:
        return None
    return day - night


def night_trend(night_lst_c_per_year) -> Optional[dict]:
    """Yearly trend in night LST. None if fewer than 3 valid (non-null) years.

    Mirrors the JS exactly: nulls are dropped first, then the *surviving* values
    are re-indexed 0..n-1 for the regression (gaps are not preserved)."""
    valid = [v for v in (night_lst_c_per_year or []) if v is not None]
    if len(valid) < 3:
        return None
    n = len(valid)
    mean_x = (n - 1) / 2
    mean_y = sum(valid) / n
    num = den = tot_ss = 0.0
    for i in range(n):
        num += (i - mean_x) * (valid[i] - mean_y)
        den += (i - mean_x) ** 2
        tot_ss += (valid[i] - mean_y) ** 2
    slope = 0 if den == 0 else num / den
    intercept = mean_y - slope * mean_x
    res_ss = sum((valid[i] - (slope * i + intercept)) ** 2 for i in range(n))
    r_squared = 1 if tot_ss == 0 else max(0, min(1, 1 - res_ss / tot_ss))
    return {"slope_c_per_yr": slope, "r_squared": r_squared}
