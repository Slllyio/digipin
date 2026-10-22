"""Tests for the structural traffic pipeline.

Pure scoring/binning helpers (stdlib) are tested directly; the NetworkX graph +
betweenness run on a tiny synthetic road network (importorskip networkx).
Heavy OSM/GTFS IO needs real data and isn't tested here.
"""
import pytest

rn = pytest.importorskip("pipeline.traffic.road_network")
tg = pytest.importorskip("pipeline.traffic.traffic_grid")
gt = pytest.importorskip("pipeline.traffic.gtfs_transit")
ot = pytest.importorskip("pipeline.traffic.osm_transit")


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


def test_osm_coverage_access_bounds():
    assert ot.coverage_access(0) == 0
    assert ot.coverage_access(1) == 25
    assert ot.coverage_access(4) == 100
    assert ot.coverage_access(20) == 100          # clamped
    assert ot.coverage_access(None) == 0


def test_osm_transit_merges_coverage_into_grid():
    grid = tg.bin_segments([], (75.6, 22.5, 76.0, 22.9), res_m=2000)
    stops = [
        {"lat": 22.51, "lng": 75.61},   # SW area
        {"lat": 22.512, "lng": 75.612},  # same neighbourhood
        {"lat": 10.0, "lng": 10.0},     # outside bbox → ignored
    ]
    out = ot.merge_into_grid(grid, stops)
    assert out["transit_source"] == "osm_stops"
    assert max(out["transit_stops"]) >= 2          # both nearby stops counted in the walk-shed
    assert max(out["transit_access"]) > 0
    assert all(h is None for h in out["transit_headway_min"])   # no timetable


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


def test_demand_model_helpers():
    from pipeline.traffic import demand_model as dm
    assert dm.road_params("primary") == (45, 1800)
    assert dm.road_params("nonsense") == dm.DEFAULT_ROAD
    assert dm.los_grade(0.3) == "A" and dm.los_grade(0.95) == "E" and dm.los_grade(1.2) == "F"
    assert dm.bpr_time(10, 0, 1000) == 10
    assert abs(dm.bpr_time(10, 1000, 1000) - 11.5) < 1e-9
    trips = dm.gravity(100, {"a": 1, "b": 1, "c": 0}, {"a": 5, "b": 25, "c": 1})
    assert abs(sum(trips.values()) - 100) < 1e-9 and trips["a"] > trips["b"] and "c" not in trips


def test_demand_model_network_assigns_flow():
    pytest.importorskip("scipy")
    from pipeline.traffic import demand_model as dm
    # A plus-shaped arterial: the east-west road crosses the north-south one mid-way.
    feats = [
        {"type": "Feature", "properties": {"highway": "primary"},
         "geometry": {"type": "LineString", "coordinates": [[75.80, 22.70], [75.81, 22.70], [75.82, 22.70]]}},
        {"type": "Feature", "properties": {"highway": "secondary"},
         "geometry": {"type": "LineString", "coordinates": [[75.81, 22.69], [75.81, 22.70], [75.81, 22.71]]}},
    ]
    net = dm.Network(feats)
    assert net.n == 5 and all(net.main)          # crossing vertex shared → one component
    zs = {"W": {"pop": 10000, "attr": 0, "lon": 75.80, "lat": 22.70},
          "N": {"pop": 0, "attr": 5000, "lon": 75.81, "lat": 22.71}}
    flow, times, n_orig, n_conn = dm.run_model(net, zs, log=lambda *_: None)
    assert n_orig == 1 and n_conn == 2
    peak = 10000 * dm.TRIPS_PER_CAPITA * dm.PCU_PER_TRIP * dm.PEAK_SHARE
    assert abs(max(flow) - peak) < 1e-6           # all trips W → N cross the junction
    rows = dm.summarise(net, feats, flow, times)
    assert feats[0]["properties"]["pcu_peak"] == round(peak)
    assert all(r["peak_los"] in "ABCDEF" for r in rows.values())


def test_demand_model_time_of_day():
    pytest.importorskip("scipy")
    from pipeline.traffic import demand_model as dm
    assert abs(sum(dm.HOURLY_SHARE) - 100) < 1e-9 and dm.PERIOD_SHARE["am"] == dm.PEAK_SHARE
    assert all(abs(sum(m) - 1) < 1e-9 for m in dm.HOURLY_MIX)
    h = dm.hourly({"am": 1.0, "pm": 0.8, "mid": 0.4})
    assert abs(h[9] - 1.0) < 1e-9 and abs(h[18] - 0.8) < 1e-9 and abs(h[13] - 0.4) < 1e-9
    assert h[3] < h[13] < h[9]
    # One road W–E: homes in the west, jobs in the east.
    feats = [{"type": "Feature", "properties": {"highway": "primary"},
              "geometry": {"type": "LineString", "coordinates": [[75.80, 22.70], [75.82, 22.70]]}}]
    net = dm.Network(feats)
    zs = {"W": {"pop": 10000, "attr": 0, "lon": 75.80, "lat": 22.70},
          "E": {"pop": 0, "attr": 5000, "lon": 75.82, "lat": 22.70}}
    periods, n_orig, n_conn = dm.run_periods(net, zs, log=lambda *_: None)
    east = [e for e in range(len(net.head)) if net.xy[net.head[e]][0] > net.xy[net.tail[e]][0]][0]
    west = 1 - east
    am, pm, mid = (periods[k][0] for k in ("am", "pm", "mid"))
    assert am[east] > 0 and am[west] == 0          # morning: to work
    assert pm[west] > 0 and pm[east] == 0          # evening: home again
    assert mid[east] > 0 and mid[west] > 0         # midday: both ways
    rows = dm.summarise(net, feats, *periods["am"], periods=periods)
    p = feats[0]["properties"]
    assert p["peak_period"] == "am" and p["vc_pm"] < p["vc_am"] and p["ffs"] == 45
    assert all({"am_vc", "pm_vc", "mid_vc", "peak_period"} <= set(r) for r in rows.values())


def test_noise_air_helpers():
    from pipeline.traffic import noise_air as na
    # CRTN: 10× the traffic is +10 dB; doubling the distance loses ~2–3 dB.
    a = na.crtn_l10_18h(10000, 40, 10)
    assert abs(na.crtn_l10_18h(100000, 40, 10) - a - 10) < 1e-9
    assert 1.5 < a - na.crtn_l10_18h(10000, 40, 20) < 3.5
    assert 60 < a < 80                                   # a busy urban road, 10 m away
    assert na.crtn_l10_18h(0, 40, 10) == float("-inf")
    assert abs(na.energy_sum([60, 60]) - 63.0103) < 1e-3
    assert abs(na.lden_from_l10(70) - 66.77) < 1e-9
    assert na.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == 1.0
    assert na.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == -1.0
    assert na.spearman([1, 2], [1, 2]) is None
    assert abs(na._seg_dist_m(75.80, 22.701, 75.79, 22.70, 75.81, 22.70, 0.92) - 111.32) < 0.5


def test_gtfs_cells_helpers():
    from pipeline.traffic import gtfs_cells as gc
    assert gc.minutes("07:30:00") == 450 and gc.minutes("25:00:00") == 1500 and gc.minutes("x") is None
    cal = [{"service_id": "WK", "wednesday": "1"}, {"service_id": "SUN", "wednesday": "0"}]
    assert gc.weekday_services(cal) == {"WK"}
    dates = [{"service_id": "A", "date": "20260101", "exception_type": "1"},
             {"service_id": "B", "date": "20260101", "exception_type": "1"},
             {"service_id": "A", "date": "20260102", "exception_type": "1"}]
    assert gc.weekday_services([], dates) == {"A", "B"}
    trips = {"t1": "R1", "t2": "R2", "t3": "R1"}
    st = [{"trip_id": "t1", "stop_id": "s1", "departure_time": "07:10:00"},
          {"trip_id": "t2", "stop_id": "s1", "departure_time": "08:40:00"},
          {"trip_id": "t3", "stop_id": "s1", "departure_time": "12:00:00"},
          {"trip_id": "tX", "stop_id": "s1", "departure_time": "07:20:00"},     # not a weekday trip
          {"trip_id": "t1", "stop_id": "s2", "departure_time": "09:59:00"}]
    per = gc.summarise_stops(st, trips)
    assert per["s1"]["departures"] == 3 and per["s1"]["peak"] == 2 and per["s1"]["routes"] == {"R1", "R2"}
    rows = gc.cell_rows({"s1": (22.7196, 75.8577), "s2": (22.7197, 75.8578), "s9": (0.0, 0.0)}, per)
    (code, r), = rows.items()                        # both stops in one L7 cell; s9 has no service
    assert len(code) == 7 and r["stops"] == 2 and r["routes"] == 2 and r["departures_day"] == 4
    assert r["peak_departures_hr"] == 1.0 and r["best_headway_min"] == 90.0     # 2 buses in 3 h at s1


def test_emergency_access_helpers_and_drive_times():
    pytest.importorskip("scipy")
    from pipeline.traffic import demand_model as dm
    from pipeline.traffic import emergency_access as ea
    assert ea.kind_of("hospital", "hospital") == "hospital"
    assert ea.kind_of(None, "emergency_room") == "hospital"
    assert ea.kind_of("place_of_learning", "high_school") == "school"
    assert ea.kind_of("restaurant", "restaurant") is None
    assert ea.period_time(2.0, 0.0) == 2.0
    assert abs(ea.period_time(2.0, 1.0) - 2.0 * (1 + dm.BPR_A)) < 1e-9
    assert ea.period_time(2.0, 50.0) == 2.0 * dm.MAX_SLOWDOWN       # floored speed
    assert abs(ea.access_min(1000) - 1.3 / 15 * 60) < 1e-9
    # One road W–E; the hospital sits at the east end; the road jams only at 09:00.
    feats = [{"type": "Feature", "properties": {"highway": "primary", "vc_am": 1.5, "vc_pm": 0.2},
              "geometry": {"type": "LineString", "coordinates": [[75.80, 22.70], [75.82, 22.70]]}}]
    net = dm.Network(feats)
    east = max(range(net.n), key=lambda i: net.xy[i][0])
    west = 1 - east
    t = ea.drive_times(net, feats, [east], [0.0])
    assert t["night"][east] < 1e-3
    assert t["night"][west] > 0 and t["am"][west] > t["pm"][west] >= t["night"][west]
    node, d = ea.Snapper(net).nearest(75.8001, 22.7001)
    assert node == west and d < 20


def test_rail_stations_helpers():
    from pipeline.traffic import rail_stations as rs
    assert rs.is_station_name("Saket Metro Station")
    assert rs.is_station_name("मुंडका रेलवे स्टेशन")
    assert not rs.is_station_name("Chaayos Cafe - Dwarka, Sector 12")
    assert not rs.is_station_name("Railway Quarters Lodhi Colony")
    assert not rs.is_station_name("Brar Square") and rs.is_station_name("Brar Square", from_osm=True)
    assert rs.kind_for("subway", "Shastri Park") == "metro"
    assert rs.kind_for("standard_gauge", "Okhla Metro Station") == "metro"
    assert rs.kind_for("standard_gauge", "Okhla Railway Station") == "rail"
    assert rs.kind_for(None, "Okhla Metro Station") is None
    assert rs.name_key("Saket Metro Station-Gate No 2") == rs.name_key("Saket metro station") == "saket"
    pts = [(77.2000, 28.5000, "metro", "Saket Metro Station"),
           (77.2050, 28.5000, "metro", "Saket Metro Station-Gate No 2"),   # ~490 m: same name merges
           (77.2050, 28.5000, "rail", "Saket Railway Station"),
           (77.3000, 28.5000, "metro", "Okhla Metro Station")]
    m = rs.merge_stations(pts)
    assert len(m) == 3 and sum(k == "metro" for *_, k, _ in m) == 2
    idx = rs.TrackIndex([("subway", [(77.0, 28.5), (77.01, 28.5)])])
    assert idx.nearest(77.005, 28.501)[0] == "subway"                     # ~110 m off the track
    assert idx.nearest(77.005, 28.51)[0] is None                          # ~1.1 km off
    assert abs(rs.walk_min(800) - 13.0) < 1e-9


def test_ev_charging_helpers():
    from pipeline.traffic import ev_charging as ev
    pts = [(77.2000, 28.5000, "charger", "A", "osm"),
           (77.2003, 28.5001, "charger", "A dup", "overture"),   # ~30 m: duplicate
           (77.2003, 28.5001, "parking", "P", "overture"),       # other kind: kept
           (77.2100, 28.5000, "charger", "B", "overture")]       # ~980 m: kept
    d = ev.dedupe(pts)
    assert [p[3] for p in d] == ["A", "P", "B"]
    near = ev.NearestKm([(77.2, 28.5), (77.5, 28.5)])
    assert abs(near(77.21, 28.5) - 0.977) < 0.01
    assert abs(near(77.45, 28.5) - 4.886) < 0.02
    assert ev.NearestKm([])(77.2, 28.5) is None


def test_road_flood_flags():
    from pipeline.traffic import road_flood as rf
    pts = rf.samples([(77.0, 28.5), (77.01, 28.5)])
    assert len(pts) == 11 and pts[0] == (77.0, 28.5)              # ~980 m → 10 steps + the end point
    wl = {}
    from pipeline._lib import digipin
    hot = digipin.encode(28.5, 77.005).replace("-", "")[:7]
    wl[hot] = 70
    f = rf.road_flags([(77.0, 28.5), (77.01, 28.5)], lambda c: wl.get(c, 20), lambda c: False)
    assert f["wlog"] == 70 and 0 < f["wlog_hi"] < 50 and f["fl100"] == 0
    g = rf.road_flags([(77.0, 28.5), (77.01, 28.5)], lambda c: 50, lambda c: True)
    assert g == {"wlog": 50, "wlog_hi": 100, "fl100": 1}


def test_cycling_islands_split_at_main_road_junctions():
    from pipeline.traffic import cycling as cy
    assert cy.stress("primary") == "high" and cy.stress("residential") == "low" and cy.stress("footway") is None
    assert cy.stress("tertiary") == "low" and cy.stress("tertiary", busy=True) == "high"
    # Two residential streets meet a primary road at junction J; a third street continues past K.
    segs = [
        ("low", [("A", 0.0), ("J", 1.0)]),
        ("low", [("J", 0.0), ("B", 1.0)]),
        ("high", [("P", 0.0), ("J", 0.5), ("Q", 1.0)]),
        ("low", [("B", 0.0), ("K", 0.5), ("C", 1.0)]),
        ("low", [("P", 0.0), ("Q", 1.0)]),                  # stub between two main-road junctions
    ]
    isl, blocked = cy.islands(segs)
    assert blocked == {"P", "J", "Q"}
    assert isl[(0, 0)] != isl[(1, 0)]                     # J does not join A and B
    assert isl[(1, 0)] == isl[(3, 0)] == isl[(3, 1)]      # B–K–C is one island
    assert isl[(4, 0)][0] == "stub"
    assert cy.pieces([("b", 1.0), ("a", 0.0), ("m", 0.4)]) == [(0.0, 0.4, "a", "m"), (0.4, 1.0, "m", "b")]
    pts = cy.walk_line([(77.0, 28.0), (77.001, 28.0)], step_m=25)
    assert len(pts) == 4 and abs(sum(p[3] for p in pts) - 98) < 2 and 0 < pts[0][2] < pts[-1][2] < 1


def test_crossing_gap_runs_chain_through_plain_connectors():
    from pipeline.traffic import crossings as cx
    # A main road A–B–C–D in three segments; a side street meets it at C; a crosswalk sits on segment 3 at X.
    segs = [
        (True, False, [("A", 0.0), ("B", 1.0)]),
        (True, False, [("B", 0.0), ("C", 1.0)]),
        (True, False, [("C", 0.0), ("X", 0.5), ("D", 1.0)]),
        (False, False, [("C", 0.0), ("S", 1.0)]),
        (False, True, [("X", 0.0), ("Y", 1.0)]),
    ]
    runs = cx.gap_runs(segs, [300, 400, 200, 50, 10])
    assert runs[(0, 0)] == runs[(1, 0)] == 700          # B is a plain continuation
    assert runs[(2, 0)] == 100 and runs[(2, 1)] == 100    # C is a junction, X a crosswalk
    assert (3, 0) not in runs
    assert cx.degrees(segs)["C"] == 3 and cx.degrees(segs)["X"] == 3


def test_freight_kinds_and_truck_routes():
    pytest.importorskip("scipy")
    from pipeline.traffic import freight as fr
    assert fr.kind_of("freight_and_cargo_service") == "logistics"
    assert fr.kind_of("pharmaceutical_products_wholesaler") == "wholesale"
    assert fr.kind_of("plastic_manufacturer") == "industry"
    assert fr.kind_of("warehouse_club_store") is None and fr.kind_of("food_truck_stand") is None
    # 0 — 1 — 2 — 3(gateway), plus a slow shortcut 0 — 3.
    links = [(0, 1, 1), (1, 0, 1), (1, 2, 1), (2, 1, 1), (2, 3, 1), (3, 2, 1), (0, 3, 10), (3, 0, 10)]
    flow = fr.route_flows(4, links, [(0, 12), (2, 4)], [3])
    assert flow[0] == 12 and flow[2] == 12 and flow[4] == 16   # 0→1→2→3 carries both sites
    assert flow[6] == 0 and flow[1] == 0


def test_job_access_transit_and_reach():
    np = pytest.importorskip("numpy")
    from pipeline.traffic import job_access as ja
    # Three zones on a line 0, 5 and 10 km east; stations at the two ends.
    k = 1 / 111.32
    zx = np.array([77.0, 77.0 + 5 * k, 77.0 + 10 * k]); zy = np.array([0.0, 0.0, 0.0])
    sx = np.array([77.0, 77.0 + 10 * k]); sy = np.array([0.0, 0.0])
    t = ja.transit_times(zx, zy, sx, sy)
    # End to end: wait 5 + 10 km × 1.25 at 33 km/h ≈ 27.7 min, far quicker than walking 10 km.
    assert t[0, 2] == pytest.approx(5 + 10 * 1.25 / 33 * 60, rel=0.01)
    assert t[0, 2] < 10_000 * ja.DETOUR / ja.WALK_M_MIN
    # The middle zone is 5 km from any station: walking only.
    assert t[1, 0] == pytest.approx(5000 * ja.DETOUR / ja.WALK_M_MIN, rel=0.01)
    share = ja.reach_share(t, [1, 1, 2])
    assert share[0] == pytest.approx(75.0)        # itself + the far end (weight 2) of 4
    assert share[1] == pytest.approx(25.0)        # only itself within 45 min
