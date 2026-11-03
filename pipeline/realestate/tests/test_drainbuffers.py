import numpy as np
import pytest

pytest.importorskip("scipy")   # CI's python-tests job does not install scipy

from pipeline.realestate import drainbuffers as D  # noqa: E402


def test_lines_reads_coordinates_after_other_tags():
    kml = """<kml><Placemark><LineString><tessellate>1</tessellate>
    <coordinates>
      77.5,12.9 77.6,12.95
    </coordinates></LineString></Placemark></kml>"""
    assert list(D.lines(kml)) == [[(77.5, 12.9), (77.6, 12.95)]]


def test_buffers_follow_rmp_and_ngt_widths():
    w = np.zeros((40, 200), bool)
    w[20, :100] = True          # a secondary drain
    m = D.buffers({"secondary": w}, px_m=10)
    assert m["buffer_pct"][22, 50] and not m["buffer_pct"][23, 50]      # 25 m: 20 m in, 30 m out
    assert m["buffer_ngt_pct"][23, 50] and not m["buffer_ngt_pct"][24, 50]  # 35 m
