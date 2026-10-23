import math

from pipeline.realestate import parks


def test_deg2_to_m2_shrinks_with_latitude():
    eq = parks.deg2_to_m2(1e-6, 0)
    assert math.isclose(eq, 111_320.0 ** 2 * 1e-6)
    assert math.isclose(parks.deg2_to_m2(1e-6, 60), eq / 2, rel_tol=1e-9)


def test_green_classes_include_parks_and_play():
    for c in ("park", "playground", "recreation_ground", "pitch"):
        assert c in parks.CLASSES
    assert "residential" not in parks.CLASSES
