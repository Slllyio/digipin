import numpy as np

from pipeline.realestate import sarfloods as sf


def test_block_rows():
    arr = np.zeros((20, 20), dtype="uint8")
    arr[0:10, :] = 1
    idx = lambda lng, lat: (int(lat), int(lng))
    rows = sf.block_rows([("wet", 5, 10), ("dry", 15, 10), ("edge", 1, 1)], arr, idx, 2023)
    assert set(rows) == {"wet", "dry"}
    assert rows["wet"]["sf_flooded_pct"] == 100 and rows["dry"]["sf_flooded_pct"] == 0
    assert rows["wet"]["sf_year"] == 2023


def test_block_rows_damage():
    arr = np.zeros((20, 20), dtype="uint8")
    dmg = np.zeros((20, 20), dtype="uint8")
    dmg[:, 0:10] = 200
    idx = lambda lng, lat: (int(lat), int(lng))
    rows = sf.block_rows([("hit", 10, 5), ("calm", 10, 15)], arr, idx, 2020, damage=(dmg, idx))
    assert rows["hit"]["sf_damage_pct"] == 100 and rows["calm"]["sf_damage_pct"] == 0
    assert "sf_damage_pct" not in sf.block_rows([("hit", 10, 5)], arr, idx, 2020)["hit"]
