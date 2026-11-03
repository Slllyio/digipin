from pipeline.realestate import serviceareas as sa


def test_ward_counts_distinct_units_per_ward():
    rows = {"a": {"power_unit": 1, "water_unit": 7}, "b": {"power_unit": 2, "water_unit": 7}, "c": {"power_unit": 3}, "d": {"power_unit": 1}}
    ward = {"a": "W1", "b": "W1", "c": "W2"}
    got = sa.ward_counts(rows, ward, {"a": "PS1", "b": "PS2"})
    assert (got["a"]["ward_power_units"], got["a"]["ward_water_units"], got["a"]["ward_police_units"]) == (2, 1, 2)
    assert got["c"]["ward_power_units"] == 1 and got["c"]["ward_police_units"] == 0
    assert got["a"]["ward_id"] == 1 and got["c"]["ward_id"] == 2
    assert "ward_id" not in got["d"]


def test_units_number_unnamed_features_in_order():
    kml = ("<kml><Document>" + "".join(
        '<Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>80,13 80.01,13 80.01,13.01 80,13</coordinates>'
        '</LinearRing></outerBoundaryIs></Polygon></Placemark>' for _ in range(2)) + "</Document></kml>")
    assert [(u[0], u[1]) for u in sa.units("power", kml)] == [(1, None), (2, None)]
