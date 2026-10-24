import numpy as np

from pipeline.realestate.downwind import sector_table, smoke


def test_sector_table_northward_wind():
    t = sector_table([(0.0, 1.0)])               # all air moving north
    assert t[0] == 1 and t[36] == 0              # bins: 0° gets it, 180° does not


def test_smoke_only_downwind_and_within_reach():
    t = sector_table([(0.0, 1.0)])
    targets = [(28.01, 77.0), (27.99, 77.0), (28.2, 77.0)]   # 1 km north, 1 km south, 22 km north
    idx, up = smoke(targets, [(28.0, 77.0, 10.0)], t, 5, 28.0)
    assert idx[0] > 0 and idx[1] == 0 and idx[2] == 0
    assert up[0] == 1 and up[1] == 0
    assert np.isclose(idx[0], 10.0 / 1.1057, rtol=0.01)
