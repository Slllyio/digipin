from pipeline.realestate import drains as dr


def test_rows_are_block_shares_and_lengths(monkeypatch):
    from pipeline.cells import store
    monkeypatch.setattr(store, "cell_bounds", lambda code: {"west": 0.0, "east": 0.001, "south": 0.0, "north": 0.001})
    cell = dr.deg2_to_m2(1e-6, 0.0005)
    rows = dr.rows_for({"ABC": {"drain_m": 120.0, "canal_m": 0.0, "near_m2": cell / 2, "ww_m2": cell / 10, "ww": 1}})
    assert rows[0] == {"digipin": "ABC", "drain_km": 0.12, "canal_km": 0.0, "drain_near_pct": 50.0, "wastewater_pct": 10.0, "wastewater": 1}


def test_shares_are_capped():
    from pipeline.cells import store
    store_bounds = store.cell_bounds
    try:
        store.cell_bounds = lambda code: {"west": 0.0, "east": 0.001, "south": 0.0, "north": 0.001}
        rows = dr.rows_for({"X": {"drain_m": 0.0, "canal_m": 0.0, "near_m2": 1e9, "ww_m2": 0.0, "ww": 0}})
        assert rows[0]["drain_near_pct"] == 100.0
    finally:
        store.cell_bounds = store_bounds
