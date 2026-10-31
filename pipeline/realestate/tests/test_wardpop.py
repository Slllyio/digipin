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


def test_calibrate_electors_capped():
    rows = {"a": {"population": 600, "projected_2030": 600}, "b": {"population": 300, "projected_2030": 300},
            "c": {"population": 100, "projected_2030": 100}}
    seat = {"a": 1, "b": 2, "c": 3}
    vol = {"a": 1, "b": 1, "c": 1}
    # Seat 1 has as many electors as seat 2 but twice GHSL's residents; seat 3 claims 20 times its GHSL share.
    n = calibrate(rows, seat, {1: 100, 2: 100, 3: 400}, vol, None, lambda c: 1, cap=2)
    assert n == 3
    assert sum(r["population"] for r in rows.values()) == 1000
    # a is held at half its GHSL share (cap), b gets 5/9 of it, c is held at twice its share; then GHSL's 1,000 is kept.
    assert [rows[k]["population"] for k in "abc"] == [450, 250, 300]


def test_elector_targets():
    from pipeline.realestate.wardpop import elector_targets
    segs = {(10, "Dum Dum", "West Bengal"): {"electors": 250000}, (11, "Far Away", "West Bengal"): {"electors": 200000},
            (13, "Kopri", "West Bengal"): {"electors": 300000},
            (10, "Elsewhere", "Assam"): {"electors": 1}}
    seat_of = {"x": (10, "Dum Dum"), "y": (11, "Far Away"), "z": (12, "Unknown"), "k": (13, "Kopri-Pachpakhadi")}
    blocks, electors = elector_targets(seat_of, segs, "West Bengal", {10: 0.99, 11: 0.5, 12: 1.0, 13: 1.0})
    assert blocks == {"x": 10, "k": 13} and electors == {10: 250000, 13: 300000}


def test_gba_electors_file():
    from pipeline.realestate.wardpop import gba_electors
    e = gba_electors()
    assert len(e) == 369 and sum(e.values()) == 8891411
    assert e[("Bengaluru Central City Corporation", "1")] == 24270 and e[("Bengaluru West City Corporation", "112")] == 19843
    assert sum(v for (b, _), v in e.items() if "East" in b) == 1041738
