from pipeline.realestate.waterstore import annual, summarise


def test_annual_needs_six_months():
    m = [(2017, k, -10.0) for k in range(1, 6)] + [(2018, k, 2.0) for k in range(1, 13)]
    assert annual(m) == {2018: 2.0}


def test_summarise_trend_and_change():
    s = {y: -2.0 * (y - 2003) for y in range(2003, 2024)}
    f = summarise(s)
    assert f["ws_trend_cm_yr"] == -2.0 and f["ws_change_cm"] == -32.0
    assert f["ws_low_year"] == 2023 and f["ws_last_cm"] == -40.0
    assert summarise({2003: 1.0}) == {}
