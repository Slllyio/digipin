"""Tests for the CA-ML urban-growth model.

Pure CA/metric helpers (numpy) are tested directly; the RandomForest fit +
hindcast are exercised on a synthetic driver stack (importorskip scikit-learn).
Raster IO (build_stack/run) needs real data and isn't tested here.
"""
import numpy as np
import pytest

np  # silence linters

ca = pytest.importorskip("pipeline.growth.urban_ca_ml")
drv = pytest.importorskip("pipeline.growth.ca_drivers")


# ── pure CA helpers ──────────────────────────────────────────────
def test_neighbourhood_fraction():
    m = np.zeros((3, 3), dtype=bool)
    m[1, 1] = True
    nb = ca.neighbourhood(m)
    # the 8 cells around centre each have exactly 1 urban neighbour (the centre)
    assert nb[0, 0] == pytest.approx(1 / 8)
    assert nb[1, 1] == 0.0          # centre has no urban neighbours


def test_markov_demand_counts_mean_gain():
    a = np.zeros((4, 4), dtype=bool)
    b = a.copy(); b[0, 0] = True            # +1
    c = b.copy(); c[0, 1] = c[0, 2] = True  # +2
    assert ca.markov_demand([a, b, c]) == 2   # mean of (1, 2) rounded


def test_allocate_step_urbanises_top_demand_nonurban_cells():
    pot = np.array([[0.1, 0.9], [0.5, 0.2]], dtype="float32")
    urban = np.zeros((2, 2), dtype=bool)
    out = ca.allocate_step(pot, urban, demand=1, neighbour_weight=0.0)
    assert out[0, 1]                         # highest potential cell urbanised
    assert int(out.sum()) == 1
    # never downgrades an urban cell, and respects eligibility cap
    out2 = ca.allocate_step(pot, np.ones((2, 2), bool), demand=3)
    assert out2.all()


def test_figure_of_merit_and_kappa_bounds():
    o0 = np.array([[1, 0], [0, 0]], dtype=bool)
    o1 = np.array([[1, 1], [1, 0]], dtype=bool)   # two new-urban cells
    perfect = o1.copy()
    fom = ca.figure_of_merit(o0, o1, perfect)
    assert fom == 1.0                              # predicted exactly the change
    assert 0.0 <= ca.kappa(o1, perfect) <= 1.0
    assert ca.kappa(o1, perfect) == 1.0
    # a wrong prediction scores lower
    wrong = o0.copy()
    assert ca.figure_of_merit(o0, o1, wrong) == 0.0


def test_slope_and_distance_helpers():
    flat = np.ones((5, 5), dtype="float32")
    assert float(drv.slope_from_dem(flat, 100).max()) == pytest.approx(0.0)
    ramp = np.tile(np.arange(5, dtype="float32") * 100, (5, 1))  # 100 m rise / 100 m run
    assert float(drv.slope_from_dem(ramp, 100).mean()) > 40      # ~45°
    pytest.importorskip("scipy")   # distance_field uses scipy.ndimage; skip cleanly if absent
    mask = np.zeros((5, 5), dtype=bool); mask[0, 0] = True
    d = drv.distance_field(mask, 100)
    assert d[0, 0] == 0.0 and d[4, 4] > d[0, 0]


# ── RF + hindcast on a synthetic, learnable landscape ────────────
def test_rf_hindcast_runs_and_scores_in_range():
    pytest.importorskip("sklearn")
    rng = np.random.default_rng(0)
    H = W = 60
    # driver 0 (suitability) drives growth PROBABILISTICALLY (graded, like reality),
    # so not-yet-urban cells still carry learnable transition potential.
    d0 = rng.random((H, W)).astype("float32")
    drivers = np.stack([d0, rng.random((H, W)).astype("float32")], axis=-1)
    sig = lambda c: 1.0 / (1.0 + np.exp(-10 * (d0 - c)))   # noqa: E731
    u2016 = rng.random((H, W)) < sig(0.80)
    u2020 = u2016 | (~u2016 & (rng.random((H, W)) < sig(0.66)))
    u2023 = u2020 | (~u2020 & (rng.random((H, W)) < sig(0.52)))
    m = ca.hindcast(drivers, u2016, u2020, u2023)
    assert 0.0 <= m["figure_of_merit"] <= 1.0
    assert -1.0 <= m["kappa"] <= 1.0
    assert m["demand_per_step"] > 0
    # a driver-aligned landscape should beat a coin flip on FoM
    assert m["figure_of_merit"] > 0.1
