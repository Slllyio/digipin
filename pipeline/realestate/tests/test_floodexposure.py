from pipeline.realestate.floodexposure import city_rows


def _c(name, r100, country="India", pop=2_000_000, **kw):
    return {"name": name, "country": country, "pop": pop, "river100": r100, **kw}


def test_city_rows_shares_and_ranks():
    rows = city_rows([_c("New Delhi", 29.1, river100_1975=20.2, river100_people=8_549_123), _c("Jaipur", 0.0),
                      _c("Paris", 10.0, country="France")])
    d, j = rows["delhi"], rows["jaipur"]
    assert d["fx_river100_pct"] == 29.1 and d["fx_river100_1975_pct"] == 20.2 and d["fx_river100_people"] == 8_549_000
    assert d["fx_world_pctile"] == 83 and d["fx_india_pctile"] == 75
    assert j["fx_world_pctile"] == 17 and "fx_lecz10_pct" not in j


def test_city_rows_skips_missing():
    assert city_rows([_c("Pune", None)]) == {}
