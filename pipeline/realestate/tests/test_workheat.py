from pipeline.realestate.workheat import city_rows, mean_days


def test_mean_days_counts_missing_years_as_zero():
    assert mean_days({1983: 10, 1984: 20}, range(1983, 1993)) == 3.0


def test_city_rows_matches_nearest_big_settlement():
    exp30 = {"a": {"lat": 28.6, "lng": 77.2, "pop": 2e7, "days": {y: 80 for y in range(2007, 2017)} | {1983: 60}},
             "b": {"lat": 28.65, "lng": 77.25, "pop": 1e5, "days": {2010: 300}},
             "c": {"lat": 19.1, "lng": 72.9, "pop": 2e6, "days": {2010: 10}}}
    rows = city_rows(exp30, {}, {"a": 40}, centre={"delhi": (77.22, 28.62), "bengaluru": (77.56, 13.01)})
    assert rows["delhi"]["wh30_late"] == 80.0 and rows["delhi"]["wh30_early"] == 6.0
    assert rows["delhi"]["wh_heat_share"] == 40 and rows["delhi"]["wh32_late"] == 0.0
    assert rows["delhi"]["wh30_india_pctile"] == 75
    assert rows["bengaluru"]["wh30_late"] == 0.0 and "wh_heat_share" not in rows["bengaluru"]
