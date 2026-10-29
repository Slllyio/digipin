from pipeline.realestate.wardpop import calibrate, gba_targets


def test_targets():
    kml = ('<Placemark><SimpleData name="Corporation">West</SimpleData><SimpleData name="ward_id">25</SimpleData>'
           '<SimpleData name="TOT_P">20170.0</SimpleData><SimpleData name="TOT_SC">9</SimpleData></Placemark>'
           '<Placemark><SimpleData name="Corporation">East</SimpleData><SimpleData name="ward_id">25</SimpleData>'
           '<SimpleData name="TOT_P"></SimpleData></Placemark>')
    assert gba_targets(kml) == {("Bengaluru West City Corporation", "25"): 20170.0}


def test_calibrate():
    rows = {"a": {"population": 900, "projected_2030": 990, "change_2000_2020_pct": 5},
            "b": {"population": 100, "projected_2030": 110},
            "c": {"population": 0, "projected_2030": 0},
            "out": {"population": 50, "projected_2030": 60, "change_2000_2020_pct": 7}}
    ward_of = {"a": "W1", "b": "W2", "c": "W2", "out": "X"}
    vol20, vol10 = {"a": 10, "b": 30, "c": 10}, {"a": 10, "b": 15, "c": 5}
    n = calibrate(rows, ward_of, {"W1": 500, "W2": 250}, vol20, vol10, lambda c: 0.5)
    assert n == 3
    # GHSL's 1,000 people are kept; W2 doubled its residential volume, so the wards weigh 500 and 500.
    assert rows["a"]["population"] == 500
    assert rows["b"]["population"] == 375 and rows["c"]["population"] == 125     # by 2020 volume within W2
    assert rows["b"]["density_km2"] == 750 and rows["b"]["projected_2030"] == 413
    assert "change_2000_2020_pct" not in rows["a"]
    assert rows["out"] == {"population": 50, "projected_2030": 60, "change_2000_2020_pct": 7}
