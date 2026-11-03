from pipeline.realestate.sundayair import summarise


def test_summarise():
    f = summarise(1.646e-4, 1.418e-4, 5.0e-5, 1.5e-4)
    assert f == {"sa_weekday": 164.6, "sa_sunday": 141.8, "sa_sunday_drop": 13.9, "sa_lockdown_drop": 66.7}


def test_summarise_missing():
    assert summarise(None, 1.0, 1.0, 1.0) == {}
    assert "sa_lockdown_drop" not in summarise(2.0, 1.0, None, 1.0)
