from pipeline.realestate.settlement2011 import rows_from


def test_rows_from_one_hot_and_skips_uninhabited():
    cells = [("A", 0, 0), ("B", 0, 0), ("C", 0, 0)]
    rows = rows_from(cells, [3, 5, None])
    assert rows == {"A": {"s11_village": 0, "s11_town": 0, "s11_census_town": 1, "s11_outgrowth": 0}}
