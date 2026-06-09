"""Golden-file parity: the Python GrowthScore port must reproduce the JS output.

The fixtures in golden/growth.json are generated *from* js/growth-score.js
(the source of truth) by gen_golden.js. This test pins the Python port to that
output case-by-case, so any drift between the browser model and the pipeline
model fails CI. Regenerate fixtures after changing the JS: ``npm run golden:scores``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline.scores import growth

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[1] / "golden" / "growth.json").read_text()
)

DISPATCH = {
    "norm_log": growth.norm_log,
    "bue_sub_score": growth.bue_sub_score,
    "den_sub_score": growth.den_sub_score,
    "cap_sub_score": growth.cap_sub_score,
    "composite": growth.composite,
    "linear_trend": growth.linear_trend,
    "emerging_class": growth.emerging_class,
    "confidence_band": growth.confidence_band,
}


def assert_close(got, want, tol=1e-9, path="out"):
    """Deep-compare with a float tolerance; numbers within tol, everything else exact."""
    if want is None:
        assert got is None, f"{path}: expected None, got {got!r}"
    elif isinstance(want, bool):
        assert got == want, f"{path}: {got!r} != {want!r}"
    elif isinstance(want, (int, float)):
        assert isinstance(got, (int, float)) and not isinstance(got, bool), f"{path}: {got!r} not numeric"
        assert abs(got - want) <= tol, f"{path}: {got!r} != {want!r}"
    elif isinstance(want, str):
        assert got == want, f"{path}: {got!r} != {want!r}"
    elif isinstance(want, dict):
        assert isinstance(got, dict) and set(got) == set(want), f"{path}: keys {sorted(got or {})} != {sorted(want)}"
        for k in want:
            assert_close(got[k], want[k], tol, f"{path}.{k}")
    elif isinstance(want, list):
        assert isinstance(got, list) and len(got) == len(want), f"{path}: len mismatch"
        for i, (g, w) in enumerate(zip(got, want)):
            assert_close(g, w, tol, f"{path}[{i}]")
    else:  # pragma: no cover - defensive
        assert got == want, f"{path}: {got!r} != {want!r}"


def _all_cases():
    for name, entries in GOLDEN.items():
        for i, entry in enumerate(entries):
            yield pytest.param(name, entry["args"], entry["out"], id=f"{name}-{i}")


@pytest.mark.parametrize("name,args,want", list(_all_cases()))
def test_python_matches_js_golden(name, args, want):
    got = DISPATCH[name](*args)
    assert_close(got, want)


def test_golden_covers_every_exported_function():
    """Guard: a newly exported JS function must gain golden coverage here."""
    assert set(GOLDEN) == set(DISPATCH)
