import math

from pipeline.realestate import cyclones as cy

CSV = """SID,SEASON,ISO_TIME,LAT,LON,USA_WIND,NEWDELHI_WIND,USA_RMW
 ,Year, ,degrees_north,degrees_east,kts,kts,nmile
A,2016,2016-12-12 00:00:00,13.0,81.0,70,,20
A,2016,2016-12-12 06:00:00,13.0,80.3,60,,20
B,1975,1975-01-01 00:00:00,13.0,80.3,90,,20
C,2020,2020-05-20 00:00:00,13.0,90.0,,93,
"""


def test_parse_keeps_window_and_scales_imd_winds():
    t = cy.parse(CSV)
    assert set(t) == {"A", "C"}
    season, pts = t["A"]
    assert season == 2016 and len(pts) == 2
    assert math.isclose(pts[0][3], 70 * 1.852)
    assert math.isclose(pts[0][4], 20 * 1.852)
    assert math.isclose(t["C"][1][0][3], 93 / 0.93 * 1.852)
    assert t["C"][1][0][4] == cy.rmw_km(t["C"][1][0][3], 13.0)


def test_vortex_and_densify():
    assert cy.wind_at(0, 100, 30) == 0
    assert cy.wind_at(30, 100, 30) == 100
    assert math.isclose(cy.wind_at(120, 100, 30), 50)
    pts = [(0, 10, 80, 100, 30), (6, 11, 80, 80, 30)]
    d = cy.densify(pts)
    assert len(d) == 13 and math.isclose(d[6][1], 10.5) and d[-1] == pts[-1]
    assert len(cy.densify([(0, 10, 80, 100, 30), (12, 11, 80, 80, 30)])) == 2


def test_gumbel_return_level():
    assert cy.gumbel_rl([0, 0, 50, 60], 44) is None
    m = [80, 90, 100, 110, 120, 95, 105] + [0] * 37
    rl = cy.gumbel_rl(m, 44)
    assert 105 < rl < 125 and cy.gumbel_rl(m, 44, T=200) > rl
    assert cy.gumbel_rl(m, 44, T=2) == 0.0


def test_winds_peak_at_the_track():
    t = cy.parse(CSV)
    rows = cy.winds([("ON", 13.0, 80.3), ("FAR", 13.0, 79.0)], t)
    assert rows["ON"]["wind_max_kmh"] > rows["FAR"]["wind_max_kmh"] > 0
    assert rows["ON"]["gale_years"] == 1 and rows["ON"]["storms_200km"] == 1
    assert rows["FAR"]["storms_200km"] == 1
