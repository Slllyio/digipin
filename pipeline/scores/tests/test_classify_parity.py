"""Golden-file parity: the Python OSM classifier must reproduce the JS output.

Fixtures in golden/classify.json are generated *from* js/data-fetcher.js
(CATEGORIES + classifyElements, the source of truth) by gen_golden.js.
Regenerate: ``npm run golden:scores``.
"""
from __future__ import annotations

import pytest

from pipeline.scores import osm_classify
from pipeline.scores.tests._parity import assert_close, load_golden

GOLDEN = load_golden("classify")


def test_match_table_matches_js():
    """Every CATEGORIES match entry is transcribed identically (135 features)."""
    want = GOLDEN["match_table"][0]["out"]
    got = osm_classify.match_table()
    # JSON round-trips tuples to lists; compare structurally.
    assert got == [[c, f, m] for c, f, m in (tuple(e) for e in want)]


@pytest.mark.parametrize(
    "args,want",
    [(e["args"], e["out"]) for e in GOLDEN["classify_elements"]],
    ids=[f"case-{i}" for i in range(len(GOLDEN["classify_elements"]))],
)
def test_classify_elements_matches_js(args, want):
    got = osm_classify.classify_elements(args[0])
    # gen_golden strips names/items to {count, subTypes}; our port emits the same.
    assert_close(got, want)


def test_relevant_keys_cover_every_matcher():
    for _, _, match in osm_classify.FEATURES:
        for key in match:
            assert key in osm_classify.RELEVANT_KEYS


def test_assemble_data_shape_feeds_compute_scores():
    from pipeline.scores.composite import compute_scores

    data = osm_classify.assemble_data(
        {"restaurants": 3, "parks": 2, "worship": 4},
        {"hindu": 2, "muslim": 1},
        {"populationDensity": {"personsPerHectare": 120}},
    )
    assert data["categories"]["food"]["features"]["restaurants"]["count"] == 3
    assert data["categories"]["entertainment"]["features"]["worship"]["subTypes"] == {"hindu": 2, "muslim": 1}
    scores = compute_scores(data)            # must not raise; produces all scores
    assert 0 <= scores["walkability"]["value"] <= 100
    assert scores["religious_diversity"]["value"] > 0
