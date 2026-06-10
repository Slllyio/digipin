"""Unit tests for the spot-check diff/summary logic (the network-free core)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

# scripts/ isn't a package; load the module directly.
_spec = importlib.util.spec_from_file_location(
    "spot_check_parity",
    Path(__file__).resolve().parents[3] / "scripts" / "spot_check_parity.py",
)
spot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(spot)


def test_compare_counts_pairs_features_and_deltas():
    rows = spot.compare_counts({"restaurants": 3, "parks": 1}, {"restaurants": 2, "river": 4})
    by = {r["feature"]: r for r in rows}
    assert by["restaurants"]["delta"] == 1      # 3 - 2
    assert by["parks"] == {"feature": "parks", "pre": 1, "live": 0, "delta": 1}
    assert by["river"] == {"feature": "river", "pre": 0, "live": 4, "delta": -4}


def test_summarize_splits_relation_heavy_share():
    # river (relation-heavy) under-counted by 4; restaurants (not) off by 1.
    rows = [spot.compare_counts({"restaurants": 3}, {"restaurants": 2, "river": 4})]
    rep = spot.summarize(rows)
    assert rep["cells"] == 1
    assert rep["total_abs_delta"] == 5
    assert rep["relation_heavy_abs_delta"] == 4
    assert rep["non_relation_abs_delta"] == 1
    assert abs(rep["relation_share"] - 0.8) < 1e-9
    assert rep["worst_features"][0] == ("river", 4)


def test_summarize_empty_is_safe():
    rep = spot.summarize([])
    assert rep["total_abs_delta"] == 0
    assert rep["relation_share"] == 0.0


def test_overpass_query_mirrors_around_radius():
    q = spot.overpass_query(22.7, 75.8, radius=400)
    assert "(around:400,22.7,75.8)" in q
    assert "out center body;" in q
    assert q.startswith("[out:json]")
