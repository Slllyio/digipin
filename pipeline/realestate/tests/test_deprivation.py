from pipeline.realestate.deprivation import rows_from


def test_rows_from_keeps_valid_scores():
    cells = [("A", 0, 0), ("B", 0, 0), ("C", 0, 0), ("D", 0, 0)]
    assert rows_from(cells, [12.34, -3.4e38, 101.0, None], nodata=-3.4e38) == {"A": {"grdi": 12.3}}
