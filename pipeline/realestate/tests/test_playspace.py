from pipeline.realestate.playspace import Grid, block_rows


def test_block_rows_nearest_and_within():
    play = [(12.9700, 77.5900, 800.0)]
    grounds = [(12.9720, 77.5900, 5000.0), (12.9900, 77.5900, 9000.0)]
    rows = block_rows([("A", 12.9700, 77.5900), ("B", 13.0300, 77.5900)], play, grounds)
    a, b = rows["A"], rows["B"]
    assert a["pl_playground_m"] == 0 and a["pl_within_500"] == 2 and a["pl_area_500"] == 5800
    assert b["pl_within_500"] == 0 and 4000 < b["pl_ground_m"] < 4500 and 6000 < b["pl_playground_m"] < 7000


def test_grid_empty():
    assert Grid([]).nearest(12.97, 77.59) is None
    assert block_rows([("A", 12.97, 77.59)], [], []) == {"A": {"pl_within_500": 0, "pl_area_500": 0}}
