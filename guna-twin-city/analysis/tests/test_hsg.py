"""Tests for Hydrologic Soil Group derivation from soil texture (hsg.py).

HSG (A=high infiltration ... D=very low) is derived from SoilGrids sand/clay
fractions using the USDA NRCS texture -> soil-group convention. Guna sits on
the Malwa plateau (black-cotton vertisols), so we expect mostly C/D.

Reference: USDA NRCS National Engineering Handbook Part 630, ch.7 (HSG).
"""
import pytest

import hsg

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "sand,clay,expected",
    [
        (20, 55, "D"),   # heavy clay / vertisol  -> very low infiltration
        (45, 42, "D"),   # sandy clay             -> D
        (30, 32, "C"),   # clay loam              -> C
        (55, 24, "C"),   # sandy clay loam        -> C
        (40, 15, "B"),   # loam                   -> B
        (65, 10, "B"),   # sandy loam             -> B
        (82, 8, "A"),    # loamy sand             -> A
        (92, 4, "A"),    # sand                   -> A
    ],
)
def test_hsg_from_texture_known_classes(sand, clay, expected):
    assert hsg.hsg_from_texture(sand, clay) == expected


def test_runoff_potential_is_monotonic_in_clay():
    """More clay never lowers runoff potential (A < B < C < D)."""
    order = {"A": 1, "B": 2, "C": 3, "D": 4}
    prev = 0
    for clay in range(0, 60, 5):
        code = order[hsg.hsg_from_texture(max(0, 100 - clay - 20), clay)]
        assert code >= prev
        prev = code


def test_vertisol_is_high_runoff_group():
    # Black cotton soil (montmorillonite clay, >40%) must be C or D
    assert hsg.hsg_from_texture(15, 50) in ("C", "D")


def test_code_mapping_round_trips():
    for group in ("A", "B", "C", "D"):
        assert hsg.code_for(group) in (1, 2, 3, 4)
        assert hsg.group_for(hsg.code_for(group)) == group


def test_array_version_matches_scalar():
    np = pytest.importorskip("numpy")
    sand = np.array([[20, 65], [82, 30]], dtype="float32")
    clay = np.array([[55, 10], [8, 32]], dtype="float32")
    grid = hsg.hsg_code_grid(sand, clay)
    assert grid[0, 0] == hsg.code_for("D")
    assert grid[0, 1] == hsg.code_for("B")
    assert grid[1, 0] == hsg.code_for("A")
    assert grid[1, 1] == hsg.code_for("C")


def test_normalizes_fractions_that_do_not_sum_to_100():
    # SoilGrids values are g/kg-ish; pass already-percent, but tolerate scale
    a = hsg.hsg_from_texture(900, 40)   # clearly sandy even if scaled x10
    assert a == "A"
