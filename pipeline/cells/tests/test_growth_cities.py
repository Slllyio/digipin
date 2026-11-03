"""scripts/build_cell_growth.py: model-grid pixels → level-7 growth cells."""
import os
import sys

import numpy as np
import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
pytest.importorskip("scipy")
bcg = pytest.importorskip("build_cell_growth")


def _grid(rows=8, cols=8):
    """A 2x2 block of L7 cells on the L8 grid (4x4 px each) around Bhopal."""
    from build_building_heights import aligned_bbox, cell_size
    lat_step, lon_step = cell_size(8)
    w, s, e, n = aligned_bbox((77.40, 23.25, 77.40 + cols * lon_step * 0.99,
                               23.25 + rows * lat_step * 0.99), 7)
    b16 = np.zeros((rows, cols), "float32")
    b23 = np.zeros((rows, cols), "float32")
    b23[:4, :4] = 0.5          # north-west cell grows from 0 to 50 %
    b16[4:, 4:] = b23[4:, 4:] = 1.0   # south-east cell fully built throughout
    return {"presence_2016": b16, "presence_2023": b23}, (w, n, lat_step, lon_step)


def test_to_cells_averages_pixels_and_drops_open_land():
    grid, origin = _grid()
    prob = np.zeros((8, 8), "float32")
    prob[:4, :4] = 0.8
    spec, table = bcg.to_cells(grid, prob, origin)
    assert spec.id == "growth" and table.level == 7
    rows = {c: {k: table.columns[k][i] for k in table.columns} for i, c in enumerate(table.codes)}
    assert len(rows) == 2                     # the two empty cells are dropped
    grew = next(r for r in rows.values() if r["built_change_pp"] > 0)
    assert grew["built_2016_pct"] == 0 and grew["built_2023_pct"] == pytest.approx(50)
    assert grew["urban_2035_pct"] == pytest.approx(80)
    full = next(r for r in rows.values() if r["built_2016_pct"] == 100)
    assert full["built_change_pp"] == 0


def test_summary_reports_each_field():
    grid, origin = _grid()
    _, table = bcg.to_cells(grid, np.zeros((8, 8), "float32"), origin)
    s = bcg.summary(table)
    assert s["cells"] == 2 and s["built_2023_pct"]["max"] == 100
