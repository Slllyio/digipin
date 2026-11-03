from pipeline.realestate.closedland import rows_from


def test_rows_from_shares_and_big_estate():
    raw = [("A", "military", 30_000.0, 600_000.0), ("A", "rail", 6_000.0, 6_000.0), ("B", "golf", 100.0, 100.0)]
    rows = rows_from(raw, lambda code: 60_000.0)
    a = rows["A"]
    assert a["cl_military_pct"] == 50.0 and a["cl_rail_pct"] == 10.0 and a["cl_golf_pct"] == 0.0
    assert a["cl_closed_pct"] == 60.0 and a["cl_big_estate"] == 1
    assert "B" not in rows
