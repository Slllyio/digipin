"""Tests for the law-and-order mobility (access-resilience) model.

Pure scoring/geometry helpers tested directly; graph articulation analysis needs
real road data + networkx and isn't tested here (covered by the traffic graph tests).
"""
import pytest

mob = pytest.importorskip("pipeline.safety.mobility")


def test_haversine_km_known_distance():
    # ~1 deg latitude ≈ 111 km
    d = mob._haversine_km(22.0, 75.0, 23.0, 75.0)
    assert 110 < d < 112


def test_mobility_risk_rises_with_isolation():
    # well-served: police next door, no chokepoint, not sealable, dense roads
    good = mob.mobility_risk(police_km=0.2, choke_near=False, sealable=False,
                             road_density_m=800, res_m=200)
    # isolated: far police, chokepoint on access, sealable pocket, sparse roads
    bad = mob.mobility_risk(police_km=6.0, choke_near=True, sealable=True,
                            road_density_m=20, res_m=200)
    assert bad > good
    assert 0 <= good <= 100 and 0 <= bad <= 100
    assert bad >= 90          # all risk factors present


def test_mobility_risk_clamped_and_none_safe():
    assert mob.mobility_risk(None, False, False, None) <= 100
    assert mob.mobility_risk(0.0, False, False, 1000, 200) >= 0


def test_access_class_bands_and_sealable_override():
    assert mob.access_class(10) == "Smooth"
    assert mob.access_class(50) == "Constrained"
    assert mob.access_class(80) == "Restricted"
    # a sealable pocket is never 'Smooth' even at low risk
    assert mob.access_class(10, sealable=True) == "Restricted"


def test_seal_analysis_finds_pocket_behind_single_bridge():
    nx = pytest.importorskip("networkx")
    G = nx.Graph()
    # mainland: a big cycle (> max_pocket ⇒ treated as the network, not a pocket)
    main = [("m", i) for i in range(2100)]
    nx.add_cycle(G, main)
    # pocket: a small cycle (2-edge-connected, within pocket size bounds)
    pocket = [("p", i) for i in range(45)]
    nx.add_cycle(G, pocket)
    # one bridge edge joins the pocket to the mainland → sealable by 1 cut
    G.add_edge(main[0], pocket[0])
    seal_bridges, sealable = mob.seal_analysis(G, nx)
    assert (main[0], pocket[0]) in seal_bridges or (pocket[0], main[0]) in seal_bridges
    assert set(pocket).issubset(sealable)        # the pocket is flagged
    assert main[5] not in sealable               # the mainland is not


def test_cell_xy_bounds():
    b = {"west": 75.6, "south": 22.5, "east": 76.0, "north": 22.9}
    x, y = mob._cell_xy(75.61, 22.89, b, 4, 4)
    assert (x, y) == (0, 0)                       # NW corner
    assert mob._cell_xy(10, 10, b, 4, 4) == (-1, -1)   # outside
