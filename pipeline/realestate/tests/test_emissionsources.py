import numpy as np
from rasterio.transform import from_origin

from pipeline.realestate.emissionsources import block_rows, disk_sum, kernel, percentile_ranks


def test_kernel_is_a_disk():
    offs = kernel(13.0, reach=2.0)
    assert (0, 0) in offs and (1, 1) in offs
    assert (2, 2) not in offs          # 3.1 km away
    assert len(offs) in range(9, 22)


def test_disk_sum_edges():
    a = np.ones((5, 5))
    s = disk_sum(a, [(0, 0), (0, 1), (1, 0)])
    assert s[0, 0] == 3 and s[4, 4] == 1


def test_percentiles_ties():
    p = percentile_ranks({"a": 1, "b": 1, "c": 5})
    assert p == {"a": 50, "b": 50, "c": 100}


def test_block_rows_shares():
    t = from_origin(77.0, 13.1, 0.01, 0.01)        # 10 x 10 window, top-left at 77.0E 13.1N
    z = np.zeros((10, 10))
    ind, home = z.copy(), z.copy()
    ind[2, 2] = 300.0                               # a factory pixel
    home[:, :] = 10.0
    grids = {"pm25": {"Industry": ind, "Residential": home}, "nox": {"Transport": np.full((10, 10), 4.0), "Industry": np.full((10, 10), 1.0)}}
    cells = [("NEAR", 13.075, 77.025), ("FAR", 13.015, 77.085)]
    rows = block_rows(cells, grids, t)
    near, far = rows["NEAR"], rows["FAR"]
    assert near["es_industry_pct"] > 50 and far["es_industry_pct"] == 0
    assert far["es_homes_pct"] == 100
    assert near["es_nox_traffic_pct"] == 80
    assert near["es_pm25_pctile"] == 100 and far["es_pm25_pctile"] == 0
