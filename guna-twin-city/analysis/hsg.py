"""Hydrologic Soil Group (HSG) derivation from soil texture.

HSG classifies how readily a soil sheds water — A (sandy, high infiltration,
low runoff) through D (clayey, very low infiltration, high runoff). It is the
soil half of the SCS Curve Number (the land-cover half lives in curve_number.py).

We derive it per cell from ISRIC SoilGrids sand/clay fractions using the USDA
NRCS texture -> soil-group convention (clay content is the dominant control on
saturated hydraulic conductivity). Guna lies on the Malwa plateau, dominated by
black-cotton vertisols (montmorillonite clay > 40%), which classify as C/D.

Reference: USDA NRCS National Engineering Handbook Part 630, ch.7.

Note: this uses clay/sand thresholds aligned to the USDA texture classes rather
than the full texture-triangle boundary equations; boundaries are simplified but
the resulting A-D assignment matches the canonical class for non-boundary soils.
"""
from __future__ import annotations

__all__ = ["hsg_from_texture", "hsg_code_grid", "code_for", "group_for"]

_CODE = {"A": 1, "B": 2, "C": 3, "D": 4}
_GROUP = {v: k for k, v in _CODE.items()}


def code_for(group: str) -> int:
    """Numeric raster code for an HSG letter (A=1 .. D=4)."""
    return _CODE[group.upper()]


def group_for(code: int) -> str:
    """HSG letter for a numeric raster code."""
    return _GROUP[int(code)]


def _to_percent(sand: float, clay: float) -> tuple[float, float]:
    # SoilGrids ships texture in g/kg (0-1000). Anything > 100 is treated as
    # g/kg and rescaled to percent.
    if sand > 100 or clay > 100:
        return sand / 10.0, clay / 10.0
    return sand, clay


def hsg_from_texture(sand_pct: float, clay_pct: float) -> str:
    """Classify a single soil's HSG (A-D) from sand and clay percentages.

    Accepts percent (0-100) or SoilGrids g/kg (auto-rescaled).
    """
    sand, clay = _to_percent(float(sand_pct), float(clay_pct))
    if clay >= 40:
        return "D"                          # clay / silty clay / sandy clay
    if clay >= 20:
        return "C"                          # clay loam / sandy clay loam / silty clay loam
    if sand >= 80 and clay < 12:
        return "A"                          # sand / loamy sand
    return "B"                              # loam / silt loam / sandy loam


def hsg_code_grid(sand, clay):
    """Vectorised HSG codes (1-4) for sand/clay rasters. Mirrors hsg_from_texture."""
    import numpy as np

    sand = np.asarray(sand, dtype="float64")
    clay = np.asarray(clay, dtype="float64")
    scaled = (sand > 100) | (clay > 100)
    sand = np.where(scaled, sand / 10.0, sand)
    clay = np.where(scaled, clay / 10.0, clay)
    code = np.select(
        [clay >= 40, clay >= 20, (sand >= 80) & (clay < 12)],
        [_CODE["D"], _CODE["C"], _CODE["A"]],
        default=_CODE["B"],
    )
    return code.astype("uint8")
