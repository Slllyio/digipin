"""Shared helpers for the golden-file score-parity tests.

Not collected by pytest (no ``test_`` prefix). Each ``test_<model>_parity.py``
loads its golden fixtures and a name->callable dispatch, then replays every case
through ``assert_close``. See pipeline/scores/README.md.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

_GOLDEN_DIR = Path(__file__).resolve().parents[1] / "golden"


def load_golden(model: str) -> dict:
    return json.loads((_GOLDEN_DIR / f"{model}.json").read_text())


def cases(golden: dict):
    """Yield one pytest param per recorded case."""
    for name, entries in golden.items():
        for i, entry in enumerate(entries):
            yield pytest.param(name, entry["args"], entry["out"], id=f"{name}-{i}")


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
