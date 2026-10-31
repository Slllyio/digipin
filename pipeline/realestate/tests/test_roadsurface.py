from pipeline.realestate import roadsurface as rs


def test_block_rows():
    roads = [
        (12.0, 77.0, "residential", "unpaved", True, 400),
        (12.0, 77.001, "residential", "paved", False, 400),
        (12.0, 77.0005, "footway", "unpaved", False, 900),      # skipped
        (12.0, 77.002, "tertiary", None, False, 200),
        (12.5, 77.5, "residential", "unpaved", False, 999),     # far away
    ]
    rows = rs.block_rows([("a", 12.0, 77.0005), ("none", 13.0, 78.0)], roads)
    assert set(rows) == {"a"}
    r = rows["a"]
    assert r["rs_known_pct"] == 80 and r["rs_unpaved_pct"] == 50 and r["rs_photo_pct"] == 50
    assert r["rs_unpaved_km"] == 0.4


def test_min_known():
    rows = rs.block_rows([("a", 12.0, 77.0)], [(12.0, 77.0, "residential", "unpaved", False, 100), (12.0, 77.0, "residential", None, False, 900)])
    assert "rs_unpaved_pct" not in rows["a"] and rows["a"]["rs_known_pct"] == 10
