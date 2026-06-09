"""Golden-file parity: the Python GrowthScore port must reproduce the JS output.

Fixtures in golden/growth.json are generated *from* js/growth-score.js (the
source of truth) by gen_golden.js. Regenerate: ``npm run golden:scores``.
"""
from __future__ import annotations

import pytest

from pipeline.scores import growth
from pipeline.scores.tests._parity import assert_close, cases, load_golden

GOLDEN = load_golden("growth")

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


@pytest.mark.parametrize("name,args,want", list(cases(GOLDEN)))
def test_python_matches_js_golden(name, args, want):
    assert_close(DISPATCH[name](*args), want)


def test_golden_covers_every_exported_function():
    """Guard: a newly exported JS function must gain golden coverage here."""
    assert set(GOLDEN) == set(DISPATCH)
