from pipeline.realestate.underpasses import kind_of, rows_from


def test_kind_of():
    assert kind_of("primary", "is_tunnel") == "road"
    assert kind_of("footway", "is_tunnel") == "ped"
    assert kind_of("trunk", "is_bridge") == "bridge"
    assert kind_of("footway", "is_bridge") is None and kind_of("track", "is_tunnel") is None


def test_rows_from_sums_per_block():
    rows = rows_from([(28.6, 77.2, "road", 120.4), (28.6, 77.2, "road", 80.0), (28.6, 77.2, "ped", 30.0), (28.6, 77.2, "bridge", 900.6)])
    (r,) = rows.values()
    assert r == {"up_road_n": 2, "up_road_m": 200, "up_ped_n": 1, "up_bridge_m": 901}
