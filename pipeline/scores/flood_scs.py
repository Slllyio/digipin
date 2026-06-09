"""Python port of the SCS Curve-Number flood model (js/flood-scs.js).

The classic USDA Soil Conservation Service rainfall->runoff model:

    S  = 25400 / CN - 254            potential maximum retention (mm)
    Ia = 0.2 * S                     initial abstraction (mm)
    Q  = (P - Ia)^2 / (P - Ia + S)   direct runoff (mm), when P > Ia else 0

Faithful, side-effect-free port; pinned to the JS output by
tests/test_flood_scs_parity.py. See pipeline/scores/README.md.
"""
from __future__ import annotations

DEFAULT_CN = 80
DEFAULT_DEPTH_PER_RUNOFF_MM = 0.02

__all__ = ["runoff_mm", "depth_from_runoff", "rainfall_to_extra_depth", "DEFAULT_CN"]


def _pos(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x > 0


def runoff_mm(rainfall_mm, cn=DEFAULT_CN):
    """SCS-CN runoff depth (mm) for a rainfall depth (mm) and curve number."""
    if not _pos(rainfall_mm) or not _pos(cn):
        return 0
    S = (25400 / cn) - 254
    Ia = 0.2 * S
    if rainfall_mm <= Ia:
        return 0
    num = (rainfall_mm - Ia) ** 2
    den = (rainfall_mm - Ia) + S
    return num / den


def depth_from_runoff(runoff_mm_value, depth_per_runoff_mm=DEFAULT_DEPTH_PER_RUNOFF_MM):
    """Linear-scale conversion runoff (mm) -> extra inundation depth (m)."""
    if not _pos(runoff_mm_value):
        return 0
    return runoff_mm_value * depth_per_runoff_mm


def rainfall_to_extra_depth(rainfall_mm, cn=DEFAULT_CN, depth_per_runoff_mm=DEFAULT_DEPTH_PER_RUNOFF_MM):
    """Rainfall -> extra depth in one call, keeping the intermediate runoff."""
    runoff = runoff_mm(rainfall_mm, cn)
    return {
        "rainfall_mm": rainfall_mm,
        "cn": cn,
        "runoff_mm": runoff,
        "extra_depth_m": depth_from_runoff(runoff, depth_per_runoff_mm),
    }
