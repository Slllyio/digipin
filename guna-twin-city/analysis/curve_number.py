"""Curve Number engine — single source of truth for SCS Curve Numbers (Guna).

Replaces the two inconsistent CN methods that existed before:
  - strategic-twin.js FloodWarning hardcoded a single CN = 78
  - flood_precise_analysis.py inferred CN from terrain SLOPE (not land cover)

Instead, CN is derived the standard, defensible way: a TR-55 land-use x
Hydrologic-Soil-Group (HSG) matrix, evaluated per cell, with the three
Antecedent-Moisture-Condition (AMC) states so runoff can be reported as a
dry -> wet band rather than a single false-precision number.

References
----------
  - USDA NRCS, TR-55 "Urban Hydrology for Small Watersheds" (1986)
  - USDA NRCS, National Engineering Handbook Part 630, ch. 9-10
  - AMC-I  conversion: Sobhani (1975)
  - AMC-III conversion: Hawkins, Hjelmfelt & Zevenbergen (1985)

This module is pure logic (no raster I/O) so it is unit-testable without GDAL;
the raster grid builder lives in build_flood_cn_summary.py which imports this.
"""
from __future__ import annotations

from typing import Mapping

__all__ = [
    "CN_TABLE",
    "DEFAULT_CN",
    "amc_i",
    "amc_iii",
    "cn_for",
    "weighted_cn",
]

# Documented fallback curve number (urban-India mixed, HSG-C/AMC-II) used when
# land cover/soil is unknown or a grid is empty. Matches flood_scs.DEFAULT_CN.
DEFAULT_CN: float = 80.0

# Fallback row for WorldCover classes not in the table (generic developed mix).
_DEFAULT_ROW: dict[str, float] = {"A": 70, "B": 80, "C": 87, "D": 90}

# ESA WorldCover 2021 class -> TR-55 curve number (AMC-II) by Hydrologic Soil
# Group. Values follow the standard TR-55 cover-type rows; the WorldCover ->
# TR-55 cover-type mapping is noted per row. Single-HSG values used previously
# (Tree 55, Crop 72, Built-up 92, ...) sit inside these ranges, so this is a
# strict refinement, not a contradiction.
CN_TABLE: dict[int, dict[str, float]] = {
    10:  {"A": 30, "B": 55, "C": 70, "D": 77},   # Tree cover    -> Woods, good condition
    20:  {"A": 35, "B": 56, "C": 70, "D": 77},   # Shrubland     -> Brush, fair condition
    30:  {"A": 39, "B": 61, "C": 74, "D": 80},   # Grassland     -> Pasture/grassland, good
    40:  {"A": 64, "B": 75, "C": 82, "D": 85},   # Cropland      -> Row crops, straight, good
    50:  {"A": 77, "B": 85, "C": 90, "D": 92},   # Built-up      -> Developed/urban, mixed imperv.
    60:  {"A": 77, "B": 86, "C": 91, "D": 94},   # Bare/sparse   -> Fallow, bare soil
    70:  {"A": 30, "B": 58, "C": 71, "D": 78},   # Snow/ice      -> woods-like proxy (absent in Guna)
    80:  {"A": 98, "B": 98, "C": 98, "D": 98},   # Water         -> open water (near-total runoff)
    90:  {"A": 80, "B": 87, "C": 90, "D": 92},   # Wetland       -> near-saturated, high runoff
    95:  {"A": 30, "B": 55, "C": 70, "D": 77},   # Mangroves     -> woods-like proxy (absent in Guna)
    100: {"A": 49, "B": 69, "C": 79, "D": 84},   # Moss/lichen   -> sparse-vegetation proxy
}


def _clamp(value: float) -> float:
    return min(100.0, max(0.0, value))


def amc_i(cn_ii: float) -> float:
    """Convert an AMC-II curve number to AMC-I (dry antecedent). Sobhani 1975."""
    if cn_ii <= 0:
        return 0.0
    if cn_ii >= 100:
        return 100.0
    return _clamp(4.2 * cn_ii / (10.0 - 0.058 * cn_ii))


def amc_iii(cn_ii: float) -> float:
    """Convert an AMC-II curve number to AMC-III (wet antecedent). Hawkins 1985."""
    if cn_ii <= 0:
        return 0.0
    if cn_ii >= 100:
        return 100.0
    return _clamp(23.0 * cn_ii / (10.0 + 0.13 * cn_ii))


def cn_for(worldcover_class: int, hsg: str, amc: str = "II") -> float:
    """Curve number for a WorldCover class + Hydrologic Soil Group at an AMC.

    amc is one of "I" (dry), "II" (normal, the table value) or "III" (wet).
    Unknown classes fall back to a documented developed-mix row.
    """
    row = CN_TABLE.get(int(worldcover_class), _DEFAULT_ROW)
    cn_ii = float(row.get(hsg.upper(), row["C"]))
    if amc == "I":
        return amc_i(cn_ii)
    if amc == "III":
        return amc_iii(cn_ii)
    return cn_ii


def weighted_cn(class_hsg_counts: Mapping[tuple[int, str], int], amc: str = "II") -> float:
    """Area-weighted curve number over a (WorldCover class, HSG) -> pixel-count map.

    Returns DEFAULT_CN for an empty map. The area weighting is correct for a
    composite catchment CN (each cell contributes its own CN proportional to
    its area), which is what TR-55 prescribes for heterogeneous land cover.
    """
    total = sum(class_hsg_counts.values())
    if total <= 0:
        return DEFAULT_CN
    acc = 0.0
    for (klass, hsg), n in class_hsg_counts.items():
        acc += cn_for(klass, hsg, amc) * n
    return acc / total
