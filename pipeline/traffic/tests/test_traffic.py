"""Tests for the structural traffic pipeline.

Pure scoring/binning helpers (stdlib) are tested directly; the NetworkX graph +
betweenness run on a tiny synthetic road network (importorskip networkx).
Heavy OSM/GTFS IO needs real data and isn't tested here.
"""
import pytest

rn = pytest.importorskip("pipeline.traffic.road_network")
tg = pytest.importorskip("pipeline.traffic.traffic_grid")
gt = pytest.importorskip("pipeline.traffic.gtfs_transit")


# ── pure scoring helpers ─────────────────────────────────────────
def test_capacity_for_class_orders_trunk_above_residential():
    assert rn.capacity_for_class("trunk") > rn.capacity_for_class("residential")
    assert rn.capacity_for_class("motorway") == 1.0
    assert rn.capacity_for_class(None) == rn.DEFAULT_CAPACITY
    assert rn.capacity_for_class(["primary"]) == rn.capacity_for_class("primary")


def test_los_from_vc_breakpoints():
    assert rn.los_from_vc(0.0) == "A"
    assert rn.los_from_vc(0.5) == "B"
    assert rn.los_from_vc(0.7) == "C"
    assert rn.los_from_vc(0.85) == "D"
    assert rn.los_from_vc(0.95) == "E"
    assert rn.los_from_vc(1.5) == "F"
    assert rn.los_from_vc(None) is None


def test_vc_ratio_and_congestion_risk():
    # high load on a low-capacity road → high V/C → high risk
    hi = rn.vc_ratio(0.2, rn.capacity_for_class("residential"))
    lo = rn.vc_ratio(0.2, rn.capacity_for_class("trunk"))
    assert hi > lo
    assert rn.congestion_risk(1.5) == 100      # clamped
    assert rn.congestion_risk(0.0) == 0
    assert rn.congestion_risk(None) is None


def test_criticality_label():
    assert rn.criticality_label(0.02, True) == "critical"
    assert rn.criticality_label(0.0, True) == "high"
    assert rn.criticality_label(0.02, False) == "high"
    assert rn.criticality_label(0.007, False) == "medium"
    assert rn.criticality_label(0.0, False) == "low"


# ── graph + betweenness on a synthetic network ───────────────────
def _line(coords, **props):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
            "properties": props}


def test_betweenness_finds_the_bridge_segment():
    pytest.importorskip("networkx")
    # Two clusters joined by a single bridge edge B–C; that edge must carry the
    # most shortest paths (highest betweenness) and be flagged a bridge.
    feats = [
        _line([[0, 0], [1, 0]], highway="residential", name="A-B"),
        _line([[1, 0], [2, 0]], highway="residential", name="B-C(bridge)"),
        _line([[2, 0], [3, 0]], highway="residential", name="C-D"),
        _line([[2, 0], [3, 1]], highway="residential", name="C-E"),
        _line([[0, 0], [0, 1]], highway="residential", name="A-F"),
    ]
    G, e2f = rn.build_graph(feats)
    betw, bridges = rn.compute_centrality(G)
    scored = rn.enrich(feats, betw, bridges, e2f)
    bridge_seg = next(s for s in scored if s["name"] == "B-C(bridge)")
    assert bridge_seg["is_bridge"] is True
    assert bridge_seg["betweenness"] == max(s["betweenness"] for s in scored)
    assert bridge_seg["los_grade"] in rn.LOS_GRADES


def test_enrich_sets_los_and_risk_props():
    pytest.importorskip("networkx")
    feats = [_line([[0, 0], [1, 0]], highway="trunk"),
             _line([[1, 0], [2, 0]], highway="residential")]
    G, e2f = rn.build_graph(feats)
    betw, bridges = rn.compute_centrality(G)
    rn.enrich(feats, betw, bridges, e2f)
    for f in feats:
        p = f["properties"]
        assert "los_grade" in p and "congestion_risk" in p and "criticality" in p


# ── grid binning ─────────────────────────────────────────────────
def test_bin_segments_assigns_worst_los_and_density():
    bbox = (75.6, 22.5, 76.0, 22.9)
    feats = [
        {"geometry": {"type": "LineString", "coordinates": [[75.61, 22.51], [75.62, 22.51]]},
         "properties": {"congestion_risk": 30, "los_grade": "B", "betweenness": 0.001,
                        "criticality": "low", "highway": "residential"}},
        {"geometry": {"type": "LineString", "coordinates": [[75.615, 22.512], [75.62, 22.513]]},
         "properties": {"congestion_risk": 90, "los_grade": "F", "betweenness": 0.05,
                        "criticality": "critical", "highway": "primary"}},
        {"geometry": {"type": "LineString", "coordinates": [[10, 10], [10.01, 10]]},
         "properties": {"congestion_risk": 99, "los_grade": "F"}},   # outside bbox
    ]
    g = tg.bin_segments(feats, bbox, res_m=2000)
    # the two in-bbox segments share a cell: worst LOS = F, max risk = 90, critical
    assert "F" in g["worst_los"]
    assert max(g["congestion_risk"]) == 90
    assert 1 in g["has_critical_link"]
    assert max(g["road_density_m"]) > 0
    # dominant_class = most road length in the cell (residential segment is longer)
    assert "residential" in [c for c in g["dominant_class"] if c]


def test_bin_segments_empty():
    g = tg.bin_segments([], (75.6, 22.5, 76.0, 22.9), res_m=2000)
    assert sum(g["congestion_risk"]) == 0
    assert all(v is None for v in g["worst_los"])


# ── GTFS frequency + access ──────────────────────────────────────
def test_stop_frequencies_median_gap():
    rows = [
        {"stop_id": "s1", "departure_time": "08:00:00"},
        {"stop_id": "s1", "departure_time": "08:10:00"},
        {"stop_id": "s1", "departure_time": "08:30:00"},   # gaps 10, 20 → median 15
        {"stop_id": "s2", "departure_time": "09:00:00"},   # single → None
    ]
    f = gt.stop_frequencies(rows)
    assert f["s1"] == 15.0
    assert f["s2"] is None


def test_access_score_frequency_dominates():
    frequent = gt.access_score(5, 4)
    sparse = gt.access_score(30, 1)
    assert frequent > sparse
    assert 0 <= sparse <= 100 and 0 <= frequent <= 100
    assert gt.access_score(None, 0) <= 100


def test_merge_into_grid_adds_transit_arrays():
    grid = tg.bin_segments([], (75.6, 22.5, 76.0, 22.9), res_m=2000)
    # tiny in-memory GTFS dir
    import tempfile
    import os
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "stops.txt"), "w") as fh:
            fh.write("stop_id,stop_lat,stop_lon\n")
            fh.write("s1,22.51,75.61\n")
        with open(os.path.join(d, "stop_times.txt"), "w") as fh:
            fh.write("trip_id,stop_id,departure_time\n")
            fh.write("t1,s1,08:00:00\nt2,s1,08:10:00\n")
        out = gt.merge_into_grid(grid, d)
    assert "transit_access" in out and "transit_stops" in out
    assert sum(out["transit_stops"]) == 1
