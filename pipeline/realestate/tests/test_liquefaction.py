import numpy as np
from affine import Affine

from pipeline.realestate import liquefaction as lq


def test_block_rows_classes_and_coverage():
    liq = np.full((40, 40), 1.5)
    liq[:, 20:] = 3.0                    # east half likely to liquefy
    sha = np.full((40, 40), 2.0)
    sha[:, 20:] = 3.2
    tf = Affine(20, 0, 0, 0, -20, 800)   # 20 m pixels, origin top-left at (0, 800)
    rows = lq.block_rows([("w", 100, 400), ("e", 700, 400), ("out", 5000, 5000)], liq, sha, tf, radius=60)
    assert rows["w"]["lq_likely_pct"] == 0 and rows["w"]["lq_index"] == 1.5 and rows["w"]["sh_high_pct"] == 0
    assert rows["e"]["lq_likely_pct"] == 100 and rows["e"]["sh_high_pct"] == 100
    assert "out" not in rows


def test_window_skips_nodata():
    a = np.full((10, 10), np.nan)
    a[5, 5] = 2.0
    assert lq.window_values(a, Affine(20, 0, 0, 0, -20, 200), 110, 90, 100).tolist() == [2.0]
