"""Golden-file parity: the Python FloodSCS port must match the JS output.

Fixtures in golden/flood_scs.json are generated *from* js/flood-scs.js (the
source of truth) by gen_golden.js. Regenerate: ``npm run golden:scores``.
"""
from __future__ import annotations

import pytest

from pipeline.scores import flood_scs
from pipeline.scores.tests._parity import assert_close, cases, load_golden

GOLDEN = load_golden("flood_scs")

DISPATCH = {
    "runoff_mm": flood_scs.runoff_mm,
    "depth_from_runoff": flood_scs.depth_from_runoff,
    "rainfall_to_extra_depth": flood_scs.rainfall_to_extra_depth,
}


@pytest.mark.parametrize("name,args,want", list(cases(GOLDEN)))
def test_python_matches_js_golden(name, args, want):
    assert_close(DISPATCH[name](*args), want)


def test_golden_covers_every_exported_function():
    assert set(GOLDEN) == set(DISPATCH)


def test_no_runoff_below_initial_abstraction():
    """Light rain (below Ia) produces zero runoff at the default CN."""
    assert flood_scs.runoff_mm(5) == 0
    assert flood_scs.runoff_mm(200) > 0
