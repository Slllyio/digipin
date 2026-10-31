from pipeline.realestate.landefficiency import below_share, city_rows, num


def test_num_reads_clipped_text():
    assert num(">5") == 5.0 and num("<-5") == -5.0 and num("0.5") == 0.5
    assert num(None) is None and num("nan") is None and num("x") is None


def test_below_share_ties_half():
    assert below_share(2, [1, 2, 3, 4]) == 38
    assert below_share(None, [1]) is None


def test_city_rows_ranks_against_big_centres():
    c = lambda name, country, pop, lue: {"name": name, "country": country, "pop": pop, "lue_00_20": lue, "lcr": 0.03, "pgr": 0.015,
                                         "lue_90_00": 2.0, "lue_10_20": None, "lue_20_30": 0.3}
    centres = [c("Pune", "India", 6e6, 2.0), c("Patna", "India", 3e6, 1.0), c("Lima", "Peru", 1e7, 0.5), c("Tiny", "Peru", 5e4, 9.0)]
    rows = city_rows(centres)
    p = rows["pune"]
    assert p["le_ratio_00_20"] == 2.0 and p["le_land_pct_yr"] == 3.0 and p["le_pop_pct_yr"] == 1.5
    assert p["le_world_pctile"] == 83 and p["le_india_pctile"] == 75      # ties with itself count half; Tiny is too small
    assert "le_ratio_10_20" not in p and p["le_ratio_20_30"] == 0.3
    assert list(rows) == ["pune"]
