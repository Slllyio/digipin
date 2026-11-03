from pipeline.realestate.powerplants import bearing_deg, exposure, rose, share_towards


def test_rose_and_sector():
    r = rose([(0.0, 2.0), (2.0, 0.0)])          # northward and eastward air, equal speed
    assert abs(share_towards(r, 0) - 0.5) < 1e-9
    assert abs(share_towards(r, 90) - 0.5) < 1e-9
    assert share_towards(r, 180) == 0


def test_bearing():
    assert abs(bearing_deg(28.0, 77.0, 29.0, 77.0)) < 1e-6
    assert abs(bearing_deg(28.0, 77.0, 28.0, 78.0) - 90) < 1


def test_exposure_downwind_only():
    plants = [(28.0, 77.0, "Coal", 1000), (28.0, 77.0, "Gas", 500)]
    r = rose([(0.0, 3.0)])                         # wind always blowing north
    rows = exposure([("N", 28.2, 77.0), ("S", 27.8, 77.0), ("FAR", 31.0, 77.0)], plants, r)
    assert rows["N"]["coal_plume"] > 0 and rows["S"]["coal_plume"] == 0
    assert rows["N"]["coal_mw_50km"] == 1000 and rows["N"]["fossil_mw_100km"] == 1500
    assert rows["FAR"]["coal_km"] is None and rows["FAR"]["coal_plume"] == 0
