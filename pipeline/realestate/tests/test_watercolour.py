from pipeline.realestate.watercolour import rows_from


def test_rows_from_keeps_river_blocks_only():
    raw = {
        "A": {"wc_water_pct": 0.5, "wc_river_pct": 0.4, "wc_weed_pct": 0.3, "wc_ndci": 0.2, "wc_ndti": -0.1},
        "B": {"wc_water_pct": 0.8, "wc_river_pct": 0.0, "wc_weed_pct": None, "wc_ndci": 0.05, "wc_ndti": -0.2},
        "C": {"wc_water_pct": 0.02, "wc_weed_pct": 0.0, "wc_ndci": 0.1},
        "D": {"wc_water_pct": None},
        "E": {"wc_water_pct": 0.5, "wc_weed_pct": None, "wc_ndci": None},
    }
    r = rows_from(raw)
    assert set(r) == {"A"}
    assert r["A"]["wc_water_pct"] == 50 and r["A"]["wc_river"] == 1 and r["A"]["wc_weed_pct"] == 30 and r["A"]["wc_ndci"] == 0.2
