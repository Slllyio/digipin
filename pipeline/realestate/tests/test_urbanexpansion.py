from pipeline.realestate.urbanexpansion import rows_from


def test_rows_from_splits_urban_and_probability():
    cells = [("A", 0, 0), ("B", 0, 0), ("C", 0, 0), ("D", 0, 0), ("E", 0, 0)]
    assert rows_from(cells, [101, 37, 255, None, 0], nodata=255) == {
        "A": {"urban_2000": 1, "p2030": None}, "B": {"urban_2000": 0, "p2030": 37}, "E": {"urban_2000": 0, "p2030": 0}}
