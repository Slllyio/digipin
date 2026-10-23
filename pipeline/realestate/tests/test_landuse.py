from pipeline.realestate import landuse as lu


def test_every_class_maps_to_one_group():
    assert lu._GROUP_OF["works"] == "industrial"
    assert lu._GROUP_OF["greenfield"] == "construction"
    assert lu._GROUP_OF["quarry"] == "quarry"
    assert len(lu._GROUP_OF) == sum(len(v) for v in lu.GROUPS.values())


def test_case_sql_names_each_class():
    sql = lu.case_sql()
    assert sql.startswith("CASE ") and sql.endswith(" ELSE NULL END")
    assert "WHEN class = 'landfill' THEN 'landfill'" in sql


def test_rows_are_block_shares(monkeypatch):
    from pipeline.cells import store
    monkeypatch.setattr(store, "cell_bounds", lambda code: {"west": 0.0, "east": 0.001, "south": 0.0, "north": 0.001})
    cell = lu.deg2_to_m2(1e-6, 0.0005)
    rows = lu.rows_for({"ABC": {"landfill": cell / 4, "_other": cell / 4}})
    assert rows[0]["landfill_pct"] == 25.0
    assert rows[0]["mapped_pct"] == 50.0
    assert rows[0]["quarry_pct"] == 0.0


def test_protected_and_esz_are_kept_out_of_mapped(monkeypatch):
    from pipeline.cells import store
    monkeypatch.setattr(store, "cell_bounds", lambda code: {"west": 0.0, "east": 0.001, "south": 0.0, "north": 0.001})
    cell = lu.deg2_to_m2(1e-6, 0.0005)
    rows = lu.rows_for({"ABC": {"protected": cell / 2, "esz": cell, "residential": cell / 10}})
    assert rows[0]["protected_pct"] == 50.0 and rows[0]["esz_pct"] == 100.0
    assert rows[0]["mapped_pct"] == 10.0
    assert "ESZ" in lu.protected_sql()
