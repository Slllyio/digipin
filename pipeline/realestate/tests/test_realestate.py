"""Tests for the real-estate pipeline's pure helpers (land value premiums, supply arithmetic)."""
import math

import pytest

lv = pytest.importorskip("pipeline.realestate.land_value")
sp = pytest.importorskip("pipeline.realestate.supply")
from pipeline._lib import digipin


def test_metro_premium_tapers_to_zero():
    assert lv.metro_premium(None) == 0
    assert lv.metro_premium(3) == lv.METRO_MAX
    assert lv.metro_premium(lv.METRO_ZERO_MIN) == 0
    mid = lv.metro_premium((lv.METRO_FULL_MIN + lv.METRO_ZERO_MIN) / 2)
    assert mid == pytest.approx(lv.METRO_MAX / 2)


def test_jobs_premium_log_and_clipped():
    assert lv.jobs_premium(100, 100) == 0
    assert lv.jobs_premium(200, 100) == pytest.approx(lv.B_JOBS * math.log(2))
    assert lv.jobs_premium(1e9, 1) == lv.JOBS_CLIP
    assert lv.jobs_premium(1, 1e9) == -lv.JOBS_CLIP
    assert lv.jobs_premium(0, 100) == 0 and lv.jobs_premium(None, 100) == 0


def test_risk_and_noise_discounts():
    assert lv.risk_discount(None, None) == 0
    assert lv.risk_discount(40, None) == lv.FLOOD_DISC
    assert lv.risk_discount(0, 70) == lv.WLOG_VHIGH[1]
    assert lv.risk_discount(0, 50) == lv.WLOG_HIGH[1]
    assert lv.risk_discount(40, 70) == pytest.approx(lv.FLOOD_DISC + lv.WLOG_VHIGH[1])
    assert lv.noise_discount(55) == 0
    assert lv.noise_discount(65) == pytest.approx(5 * lv.NOISE_PER_DB)
    assert lv.noise_discount(120) == lv.NOISE_CAP


def test_disk_sum_and_mean():
    code = digipin.normalize(digipin.encode(28.6139, 77.2090))[:7]
    ix = digipin.to_index(code)
    nb = digipin.from_index(ix["level"], ix["row"], ix["col"] + 1)
    far = digipin.from_index(ix["level"], ix["row"], ix["col"] + 5)
    vals = {code: 2.0, nb: 3.0, far: 100.0}
    assert lv.disk_sum(vals, code, 1) == 5.0
    assert lv.disk_mean(vals, code, 1) == 2.5
    assert lv.disk_mean({}, code, 1) is None


def test_quintile():
    s = list(range(100))
    assert lv.quintile(s, -1) == 1
    assert lv.quintile(s, 50) == 3
    assert lv.quintile(s, 1000) == 5
    assert lv.quintile([], 3) is None


def test_new_floor_area():
    # 10 new buildings at a 20%-covered 60,000 m² cell with 100 buildings (120 m² each), 9 m tall (3 storeys)
    assert sp.new_floor_m2(10, 20, 100, 9, 60000) == pytest.approx(10 * 120 * 3)
    assert sp.new_floor_m2(0, 20, 100, 9, 60000) == 0
    assert sp.new_floor_m2(5, 20, 100, 1, 60000) == pytest.approx(5 * 120)  # at least one storey


def test_vacant_share_and_headroom():
    assert sp.vacant_share(10, 5, 5) == 20
    assert sp.vacant_share(10, 5, 5, water=60) == 0
    assert sp.vacant_share(None, None, None) == 0
    assert sp.headroom_m2(1.0, 2.0, 1000) == 1000
    assert sp.headroom_m2(3.0, 2.0, 1000) == 0
    assert sp.headroom_m2(None, 2.0, 1000) == 0


cal = pytest.importorskip("pipeline.realestate.calibrate")


def test_spearman_and_ranks():
    assert cal.ranks([3, 1, 2]) == [2, 0, 1]
    assert cal.ranks([1, 1, 2]) == [0.5, 0.5, 2]
    assert cal.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1)
    assert cal.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1)
    assert cal.spearman([1, 2], [1, 2]) is None


def test_knots_rank_match_and_interpolate():
    kn = cal.knots([50, 100, 150, 200, 250], [10000, 20000, 40000, 80000, 160000], n=5)
    assert kn[0] == [50, 10000] and kn[-1] == [250, 160000]
    assert cal.interp_rate(kn, 10) == 10000
    assert cal.interp_rate(kn, 1000) == 160000
    assert cal.interp_rate(kn, 125) == pytest.approx(math.sqrt(20000 * 40000))


bd = pytest.importorskip("pipeline.realestate.building_dynamics")


def test_build_year_median_of_additions():
    # 10 added in 2018, 10 in 2020: half reached in 2018
    assert bd.build_year({2016: 10, 2017: 10, 2018: 20, 2019: 20, 2020: 30}) == 2018
    assert bd.build_year({2016: 10, 2023: 11}) is None


def test_acceleration():
    assert bd.acceleration({2016: 0, 2020: 40, 2023: 60}) == pytest.approx((20 / 3) / 10)
    assert bd.acceleration({2016: 0, 2020: 1, 2023: 60}) is None
    assert bd.acceleration({2016: 0, 2023: 60}) is None


def test_metro_future_helpers():
    from pipeline.realestate import metro_future as mf
    assert mf.walk_min(1.0) == pytest.approx(1000 * 1.3 / 80)
    assert mf.uplift_pct(30, 5) == pytest.approx(100 * (math.exp(lv.metro_premium(5)) - 1))
    assert mf.uplift_pct(5, 30) == 0.0
    assert mf.uplift_pct(None, 4) > 0
    rows = mf.parse_rows([
        {"s": {"value": "http://www.wikidata.org/entity/Q2"}, "sLabel": {"value": "B"}, "c": {"value": "Point(77.6 12.9)"},
         "st": {"value": "http://www.wikidata.org/entity/Q12377751"}},
        {"s": {"value": "http://www.wikidata.org/entity/Q1"}, "sLabel": {"value": "A"}, "c": {"value": "Point(77.2 28.6)"},
         "open": {"value": "2026-01-05T00:00:00Z"}},
        {"s": {"value": "http://www.wikidata.org/entity/Q3"}, "c": {"value": "Point(77.2 28.7)"}, "open": {"value": "2010-01-01T00:00:00Z"}},
    ])
    assert [r["id"] for r in rows] == ["Q1", "Q2", "Q3"]
    assert rows[1] == {"id": "Q2", "name": "B", "lat": 12.9, "lng": 77.6, "open": None, "state": "under_construction"}
    assert [r["id"] for r in mf.upcoming(rows)] == ["Q1", "Q2"]


def test_places_classify_and_rows():
    from pipeline.realestate import places as pl
    assert pl.classify("food_and_drink", "indian_restaurant") == ("food", False, False, False)
    assert pl.classify("services_and_business", "software_development")[1] is True
    assert pl.classify("services_and_business", "bank_or_credit_union")[2] is True
    assert pl.classify("services_and_business", "real_estate_service")[3] is True
    assert pl.evenness({"food": 2}) is None
    assert pl.evenness({k: 1 for k in pl.KINDS}) == 1.0
    rows = pl.rows_from([(77.2, 28.6, "food_and_drink", "cafe", "Starbucks"), (77.2, 28.6, "shopping", "clothing_store", None),
                         (77.2, 28.6, "health_care", "pharmacy", None)])
    (row,) = rows.values()
    assert row["places"] == 3 and row["food"] == 1 and row["shopping"] == 1 and row["health"] == 1
    assert row["branded_pct"] == 33.3 and 0 < row["diversity"] < 1
