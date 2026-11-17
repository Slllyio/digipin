"""Pure helpers of buildingform.py and streetform.py (footprint morphology and street orientation order)."""
import math

import pytest

shapely = pytest.importorskip("shapely")
np = pytest.importorskip("numpy")

from pipeline.realestate import buildingform as bf  # noqa: E402
from pipeline.realestate import streetform as sf  # noqa: E402


def test_shape_metrics_square_and_strip():
    sq = shapely.box(0, 0, 10, 10)
    strip = shapely.box(0, 0, 40, 5)
    m = bf.shape_metrics(np.array([sq, strip]))
    assert m["area"][0] == pytest.approx(100)
    assert m["elong"][0] == pytest.approx(1.0)
    assert m["elong"][1] == pytest.approx(5 / 40)
    assert m["compact"][0] == pytest.approx(100 / (math.pi * 50), rel=1e-6)  # r = half-diagonal
    assert m["compact"][1] < m["compact"][0]
    assert m["theta"][1] == pytest.approx(0, abs=1e-9) or m["theta"][1] == pytest.approx(math.pi, abs=1e-9)


def test_alignment_grid_vs_random():
    assert bf.alignment([0, math.pi / 2, 0, math.pi / 2]) == pytest.approx(100)
    spread = np.linspace(0, math.pi / 2, 50, endpoint=False)
    assert bf.alignment(spread) < 5
    assert bf.alignment([]) is None


def test_neighbour_metrics_attached_row_and_lone_house():
    row = [shapely.box(i * 10, 0, i * 10 + 10, 10) for i in range(3)]
    lone = shapely.box(100, 0, 110, 10)
    att, swr, gap = bf.neighbour_metrics(np.array(row + [lone]))
    assert list(att) == [True, True, True, False]
    assert swr[1] > swr[0] > 0  # the middle house shares two walls
    assert swr[3] == 0
    assert gap[0] == pytest.approx(0)
    assert gap[3] == pytest.approx(70)


def test_block_rows_skips_small_blocks():
    codes = np.array(["A"] * 5 + ["B"] * 2)
    n = len(codes)
    m = {"area": np.full(n, 50.0), "compact": np.full(n, 0.6), "elong": np.full(n, 0.5), "theta": np.zeros(n)}
    rows = bf.block_rows(codes, m, np.ones(n, bool), np.full(n, 0.2), np.full(n, 1.0))
    assert [r["digipin"] for r in rows] == ["A"]
    assert rows[0]["bf_attached_pct"] == 100 and rows[0]["bf_align"] == pytest.approx(100)


def test_orientation_order_grid_and_uniform():
    grid = [0.0] * sf.BINS
    for k in (0, 9, 18, 27):
        grid[k] = 1.0
    assert sf.orientation_order(grid) == pytest.approx(1.0)
    assert sf.orientation_order([1.0] * sf.BINS) == pytest.approx(0.0)
    assert sf.orientation_order([0.0] * sf.BINS) is None


def test_bearing_hist_bins_both_directions():
    k1, k2, _ = sf.bearing_hist(np.array([0.0, 1.0]), np.array([1.0, 0.0]), np.array([1.0, 1.0]))
    assert list(k1) == [0, 9]  # north, east
    assert list(k2) == [18, 27]  # south, west
