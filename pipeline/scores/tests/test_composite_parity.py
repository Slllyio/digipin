"""Golden-file parity: the Python composite-scores port must match the JS output.

Fixtures in golden/composite.json are generated *from* js/data-fetcher.js
(DataFetcher.computeScores, the source of truth) by gen_golden.js.
Regenerate: ``npm run golden:scores``.
"""
from __future__ import annotations

import pytest

from pipeline.scores import composite
from pipeline.scores.tests._parity import assert_close, cases, load_golden

GOLDEN = load_golden("composite")

DISPATCH = {
    "compute_scores": composite.compute_scores,
}


@pytest.mark.parametrize("name,args,want", list(cases(GOLDEN)))
def test_python_matches_js_golden(name, args, want):
    assert_close(DISPATCH[name](*args), want)


def test_golden_covers_every_exported_function():
    assert set(GOLDEN) == set(DISPATCH)
