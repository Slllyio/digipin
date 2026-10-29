import pytest

pytest.importorskip("scipy")   # CI's python-tests job does not install scipy

from pipeline.realestate.newroads import alignment, dedupe, nearest, records

KML = """<kml><Placemark><LineString><coordinates>77.60,12.90 77.60,12.91 77.60,12.92</coordinates></LineString></Placemark>
<Placemark><LineString><coordinates>77.601,12.90 77.601,12.92</coordinates></LineString></Placemark>
<Placemark><LineString><coordinates>77.70,12.90 77.70,12.901</coordinates></LineString></Placemark></kml>"""


def test_alignment_drops_ticks_and_dedupe_drops_parallel_edges():
    ls, outline = alignment(KML)
    assert not outline
    assert len(ls) == 1                     # two-point lines go when a longer centreline exists
    edge = [(77.6009, 12.90), (77.6009, 12.905), (77.6009, 12.92)]   # ~100 m beside it
    far = [(77.62, 12.90), (77.62, 12.905), (77.62, 12.92)]
    assert len(dedupe([ls[0], edge, far])) == 2


def test_nearest_and_records():
    cells = [("A", 12.91, 77.601), ("B", 12.91, 77.65), ("C", 12.91, 77.80)]
    near = nearest(cells, [(1, [(12.90, 77.60), (12.92, 77.60)])])
    assert set(near) == {"A"} or set(near) == {"A", "B"}
    assert near["A"][1] == 1 and near["A"][0] < 1200
    recs = records(cells[:1], {1: [[(77.60, 12.90), (77.60, 12.92)]]}, {1: 1})
    assert recs[0]["newroad_kind"] == 1
    assert round(sum(r.get("newroad_len_m", 0) for r in recs)) in range(2150, 2260)


def test_polygon_outline_counts_half():
    poly = """<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>77.60,12.90 77.6005,12.90 77.6005,12.92
    77.60,12.92 77.60,12.90</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>"""
    ls, outline = alignment(poly)
    assert outline and len(ls) == 1
    full = sum(r.get("newroad_len_m", 0) for r in records([], {1: ls}, {1: 2}))
    half = sum(r.get("newroad_len_m", 0) for r in records([], {1: ls}, {1: 2}, {1}))
    assert round(half * 2) == round(full) and 2200 < half < 2300
