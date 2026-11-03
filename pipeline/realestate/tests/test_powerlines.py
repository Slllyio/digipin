from pipeline.realestate import powerlines as pl


def test_kv_of_reads_the_highest_voltage():
    assert pl.kv_of("220000") == 220
    assert pl.kv_of("220000;66000") == 220
    assert pl.kv_of(None) is None
    assert pl.kv_of("high") is None


def test_row_widths_follow_the_voltage_steps():
    assert pl.row_m(765) == 67
    assert pl.row_m(400) == 46
    assert pl.row_m(220) == 35
    assert pl.row_m(132) == 27
    assert pl.row_m(66) == 18
    assert pl.row_m(500) == 46


def test_rows_are_block_shares(monkeypatch):
    from pipeline.cells import store
    monkeypatch.setattr(store, "cell_bounds", lambda code: {"west": 0.0, "east": 0.001, "south": 0.0, "north": 0.001})
    cell = pl.deg2_to_m2(1e-6, 0.0005)
    rows = pl.rows_for({"ABC": {"line_m": 111.0, "corridor_m2": cell / 4, "max_kv": 220.0, "substations": 1}})
    assert rows[0] == {"digipin": "ABC", "line_km": 0.111, "corridor_pct": 25.0, "max_kv": 220, "substations": 1}
