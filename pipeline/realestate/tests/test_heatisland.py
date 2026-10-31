from pipeline.realestate.heatisland import mean_of, slope_per_decade, summarise


def test_slope_per_decade():
    s = {y: 100 + 5 * (y - 2001) for y in range(2001, 2021)}      # +5 hundredths a year
    assert abs(slope_per_decade(s) - 50) < 1e-9
    assert slope_per_decade({2001: 1, 2002: 2}) is None


def test_mean_needs_three_years():
    assert mean_of({2016: 100, 2017: 200}, range(2016, 2021)) is None
    assert mean_of({2016: 100, 2017: 200, 2018: 300}, range(2016, 2021)) == 200


def test_summarise_in_degrees():
    flat = lambda v: {y: v for y in range(2001, 2021)}
    f = summarise(flat(10), flat(390), flat(60), {y: 200 - 3 * (y - 2001) for y in range(2001, 2021)}, flat(-140))
    assert f["hi_surf_night"] == 3.9 and f["hi_surf_day"] == 0.1 and f["hi_summer_surf_day"] == -1.4
    assert f["hi_air_night_trend"] == -0.3 and f["hi_surf_night_trend"] == 0.0
