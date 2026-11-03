from pipeline.realestate.popsince1975 import row_from


def test_row_from_finds_boom_and_empty():
    r = row_from({1975: 100, 1990: 200, 2000: 1200, 2010: 1500, 2020: 2000}, 0.5)
    assert r["pop_1975"] == 50 and r["pop_2020"] == 1000
    assert r["empty_1975"] == 1 and r["boom_period"] == 2


def test_row_from_needs_2020_and_handles_decline():
    assert row_from({1975: 5000, 2020: None}, 1) is None
    r = row_from({1975: 9000, 1990: 8000, 2000: 7000, 2010: 6000, 2020: 5000}, 1)
    assert r["empty_1975"] == 0 and "boom_period" not in r
