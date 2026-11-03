from pipeline.realestate.diwaliair import summarise


def test_summarise_median_jump_and_worst():
    f = summarise({2017: (100.0, 150.0), 2018: (100.0, 300.0), 2019: (100.0, 120.0), 2020: (None, None)})
    assert f["dw_jump_pct"] == 50 and f["dw_worst_year"] == 2018 and f["dw_worst_after"] == 300 and f["dw_years"] == 3
    assert f["dw_before"] == 100.0 and f["dw_after"] == 190.0


def test_summarise_needs_three_years():
    assert summarise({2017: (1.0, 2.0), 2018: (1.0, 2.0)}) == {}
