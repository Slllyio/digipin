from pipeline.realestate.quakehistory import km, parse, rows_from


def test_km():
    assert abs(km(28.6, 77.2, 19.07, 72.88) - 1150) < 20


def test_rows_from_counts_and_nearest():
    quakes = [(28.7, 77.2, 5.5, 1960), (30.8, 78.8, 6.8, 1991), (10.0, 77.0, 7.0, 2000), (28.6, 77.3, 4.0, 2020)]
    r = rows_from([("A", 28.6, 77.2)], quakes)["A"]
    assert r["qh_n45"] == 2 and r["qh_n6"] == 1
    assert r["qh_max_mag"] == 6.8 and r["qh_max_year"] == 1991
    assert 10 < r["qh_near_m5_km"] < 12


def test_parse_skips_missing_magnitude():
    g = {"features": [{"properties": {"mag": None, "time": 0}, "geometry": {"coordinates": [1, 2, 3]}},
                      {"properties": {"mag": 5.1, "time": 0}, "geometry": {"coordinates": [77.0, 28.0, 10]}}]}
    assert parse(g) == [(28.0, 77.0, 5.1, 1970)]
