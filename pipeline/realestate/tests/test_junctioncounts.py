from pipeline.realestate import junctioncounts as jc


def test_block_rows_nearest_junction_and_reach():
    js = [("A", 12.97, 77.59, (12000, 9000), (13000, 9500), 200000, 158), ("B", 12.90, 77.62, (8000, 6000), (7000, 5000), None, 77)]
    cords = [("C", 12.91, 77.62, 150000)]
    rows = jc.block_rows([("x", 12.971, 77.591), ("y", 12.901, 77.621), ("far", 13.3, 77.9)], js, cords)
    assert set(rows) == {"x", "y"}
    assert rows["x"]["jc_peak_veh"] == 13000 and rows["x"]["jc_peak_pcu"] == 9500
    assert rows["x"]["jc_daily_veh"] == 200000 and rows["x"]["jc_km"] < 0.2
    assert rows["y"]["jc_peak_veh"] == 8000 and rows["y"]["jc_daily_veh"] == 150000


def test_tables_are_unique_and_in_bengaluru():
    names = [j[0] for j in jc.JUNCTIONS]
    assert len(names) == len(set(names)) == 28
    for j in jc.JUNCTIONS:
        assert 12.85 < j[1] < 13.1 and 77.45 < j[2] < 77.7
        assert j[3][0] > j[3][1] * 0.95 or j[6] == 158
