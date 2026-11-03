from pipeline.realestate import railways as rw


def test_rows_are_block_shares_and_lengths(monkeypatch):
    from pipeline.cells import store
    monkeypatch.setattr(store, "cell_bounds", lambda code: {"west": 0.0, "east": 0.001, "south": 0.0, "north": 0.001})
    cell = rw.deg2_to_m2(1e-6, 0.0005)
    rows = rw.rows_for({"ABC": {"rail_m": 250.0, "metro_m": 120.0, "near_m2": cell / 4, "band_m2": cell * 3}})
    assert rows[0] == {"digipin": "ABC", "rail_km": 0.25, "metro_km": 0.12, "rail_near_pct": 25.0, "rail_band_pct": 100.0}


def test_metro_classes_are_kept_apart():
    assert "subway" in rw.METRO_CLASSES and "standard_gauge" not in rw.METRO_CLASSES
    assert rw.NEAR_M < rw.BAND_M
