from pipeline.realestate.droughts import summarise


def test_summarise_counts_halves_and_worst():
    s = {y: 0.0 for y in range(1901, 2025)}
    s.update({1918: -2.4, 1950: -1.2, 1987: -1.6, 2009: -1.1, 2019: 1.3})
    f = summarise(s)
    assert f["dr_dry_early"] == 2 and f["dr_dry_late"] == 2
    assert f["dr_severe_years"] == 2 and f["dr_wet_late"] == 1
    assert f["dr_worst_year"] == 1918 and f["dr_worst_spei"] == -2.4 and f["dr_last_dry"] == 2009


def test_summarise_needs_a_long_record():
    assert summarise({y: 0.0 for y in range(2000, 2020)}) == {}
