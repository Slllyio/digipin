import datetime as dt

from pipeline.realestate import climaterecord as cr


def test_dates_and_values():
    assert cr._date("02-01-1951") == dt.date(1951, 1, 2)
    assert cr._date("45464") == dt.date(2024, 6, 21)
    assert cr._date("x") is None and cr._f("-----") is None


def test_figures_then_vs_now():
    rows = []
    for y in range(1951, 2021):
        warm = 1.0 if y >= 1991 else 0.0
        for d in range(365):
            day = dt.date(y, 1, 1) + dt.timedelta(days=d)
            rows.append((day, 0.0, 30 + (d % 20) * 0.5 + warm, 20 + (d % 10) * 0.2))
    rows.append((dt.date(2022, 1, 1), 0.0, 50.0, 40.0))          # after the 2021 source change: ignored
    f = cr.figures(rows)
    assert f["cc_tmax_change"] == 1.0 and f["cc_tmin_change"] == 0.0
    assert f["cc_hot_now"] > f["cc_hot_then"]
    assert f["cc_last_year"] == 2020
