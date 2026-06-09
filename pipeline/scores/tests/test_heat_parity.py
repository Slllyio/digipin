"""Golden-file parity: the Python HeatScore port must reproduce the JS output.

Fixtures in golden/heat.json are generated *from* js/heat-score.js (the source
of truth) by gen_golden.js. Regenerate: ``npm run golden:scores``.
"""
from __future__ import annotations

import pytest

from pipeline.scores import heat
from pipeline.scores.tests._parity import assert_close, cases, load_golden

GOLDEN = load_golden("heat")

DISPATCH = {
    "lst_raw_to_celsius": heat.lst_raw_to_celsius,
    "uhi_score": heat.uhi_score,
    "diurnal_range_c": heat.diurnal_range_c,
    "night_trend": heat.night_trend,
}


@pytest.mark.parametrize("name,args,want", list(cases(GOLDEN)))
def test_python_matches_js_golden(name, args, want):
    assert_close(DISPATCH[name](*args), want)


def test_golden_covers_every_exported_function():
    """Guard: a newly exported JS function must gain golden coverage here."""
    assert set(GOLDEN) == set(DISPATCH)
