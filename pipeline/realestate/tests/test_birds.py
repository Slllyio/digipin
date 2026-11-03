import pytest

from pipeline.realestate import birds as B


def test_rarefied_richness():
    assert B.rarefied([1] * 300) == pytest.approx(200)   # all singletons: every draw is new
    assert B.rarefied([150, 50]) == pytest.approx(2)
    assert B.rarefied([10] * 5) is None                                 # fewer records than the draw
    assert 1 < B.rarefied([290, 5, 5]) < 3


def test_blocks_cover_the_bbox_at_level_6():
    codes = B.blocks((77.27, 24.60, 77.35, 24.68))
    assert all(len(c) == 6 for c in codes) and 80 <= len(codes) <= 110
