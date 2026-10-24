from pipeline.realestate.levelcrossings import MAIN_RANK, rows_from


def test_rows_count_and_rank():
    pts = [(28.6, 77.2, 1), (28.6, 77.2, 4), (19.0, 72.8, 2)]
    rows = rows_from(pts)
    assert sum(r["crossings"] for r in rows.values()) == 3
    assert sum(r["crossings_main"] for r in rows.values()) == 2
    assert max(r["road_rank"] for r in rows.values()) == 4
    assert MAIN_RANK == 2
