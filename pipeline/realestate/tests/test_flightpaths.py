from pipeline.realestate import flightpaths as fp


def test_corridor_beyond_the_runway_end():
    # Runway along x from 0 to 3 km.
    d, out = fp.corridor(5, 0.2, 0, 0, 3, 0)
    assert out == 2 and abs(d - (2 ** 2 + 0.04) ** 0.5) < 1e-9
    assert fp.corridor(5, 2, 0, 0, 3, 0)[1] is None          # too far to the side for 2 km out
    assert fp.corridor(1.5, 1, 0, 0, 3, 0) == (1, None)      # alongside the runway, not under a path
    assert fp.corridor(-12, 0, 0, 0, 3, 0)[1] is None        # beyond 10 km
