from pipeline.realestate import landslidesus as ls


def test_block_rows():
    wins = {(1, 1): [[1, 2, 5], [1, 3, 1], [0, 0, 1]], (2, 2): [[0, 0, 0], [0, 0, 0], [0, 0, 0]], (3, 3): [[127, 1, 1], [1, 1, 1], [1, 2, 1]]}
    rows = ls.block_rows([("a", 1, 1), ("b", 2, 2), ("c", 3, 3)], lambda la, lo: wins[(la, lo)])
    assert set(rows) == {"a", "c"}
    assert rows["a"] == {"ls_class": 3, "ls_near_max": 5, "ls_moderate": 1}
    assert rows["c"] == {"ls_class": 1, "ls_near_max": 2, "ls_moderate": 0}
