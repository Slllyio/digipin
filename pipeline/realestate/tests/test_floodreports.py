from pipeline.realestate.floodreports import spots_near


def test_spots_near_counts_and_events():
    pts = [(13.05, 80.25, "2015"), (13.0505, 80.25, "2005"), (13.06, 80.25, "2015")]
    out = spots_near([("A", 13.05, 80.25), ("B", 13.20, 80.25)], pts)
    assert out == {"A": (2, {"2015", "2005"})}
