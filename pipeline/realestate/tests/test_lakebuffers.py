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
