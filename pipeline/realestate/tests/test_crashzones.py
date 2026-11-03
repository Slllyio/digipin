from pipeline.realestate import crashzones as cz


def test_block_rows_distance_and_counts():
    zones = [("A", 28.60, 77.20), ("B", 28.605, 77.20), ("C", 28.70, 77.20)]
    r = cz.block_rows([("x", 28.601, 77.20), ("y", 28.65, 77.20)], zones)
    assert r["x"]["cz_500m"] == 1 and r["x"]["cz_1km"] == 2 and r["x"]["cz_km"] == 0.11
    assert r["y"]["cz_500m"] == 0 and r["y"]["cz_1km"] == 0
    assert cz.block_rows([("x", 1, 2)], []) == {}
