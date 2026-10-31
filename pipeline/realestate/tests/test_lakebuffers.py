import numpy as np
import pytest

pytest.importorskip("scipy")   # CI's python-tests job does not install scipy

from pipeline.realestate import lakebuffers as LB


def test_masks_rings_exclude_the_lake():
    lake = np.zeros((40, 40), bool)
    lake[10:20, 10:20] = True
    m = LB.masks(lake, px_m=10)
    assert m["lake_pct"].sum() == 100
    assert not (m["buffer30_pct"] & lake).any()
    assert m["buffer30_pct"][15, 22] and not m["buffer30_pct"][15, 24]   # 30 m and 50 m from the shore
    assert m["buffer75_pct"][15, 26] and (m["buffer75_pct"] | ~m["buffer30_pct"]).all()


def test_small_tanks_get_the_narrow_buffer():
    big, small = np.zeros((60, 60), bool), np.zeros((60, 60), bool)
    big[5:15, 5:15] = True
    small[40:45, 40:45] = True
    m = LB.masks(big, px_m=10, small=small)
    assert m["lake_pct"][42, 42] and m["lake_pct"][10, 10]
    assert m["buffer30_pct"][10, 17]                                  # 30 m buffer round the big tank (20 m off)
    assert m["buffer30_pct"][42, 45] and not m["buffer30_pct"][42, 47]  # 9 m round the small one, not 20 m
    assert m["buffer75_pct"][42, 47]
