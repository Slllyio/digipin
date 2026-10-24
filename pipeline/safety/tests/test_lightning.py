from pipeline.safety import lightning as lt


def test_cg_fraction_india():
    assert 0.18 < lt.cg_fraction(28.6) < 0.2      # Delhi
    assert 0.14 < lt.cg_fraction(13.0) < 0.16     # Bengaluru


def test_bilinear_skips_missing_corners():
    lats, lons = [0.25, 0.75], [10.25, 10.75]
    grid = [[2.0, 4.0], [0.0, 6.0]]
    assert lt.bilinear(grid, lats, lons, 0.25, 10.25) == 2.0
    mid = lt.bilinear(grid, lats, lons, 0.5, 10.5)
    assert mid == (2 + 4 + 6) / 3

