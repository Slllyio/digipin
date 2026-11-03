from pipeline.realestate.roomrank import city_rows


def _c(name, v20, p20, v00=None, p00=None, country="India", pop=2_000_000, tiers=(10, 80, 10)):
    return {"name": name, "country": country, "pop": pop, "v2000": v00, "p2000": p00, "v2020": v20, "p2020": p20,
            "low": tiers[0], "mid": tiers[1], "high": tiers[2]}


def test_city_rows_volume_per_person():
    rows = city_rows([_c("New Delhi", 157e6, 1e6, 209e6, 1e6), _c("Paris", 337e6, 1e6, country="France"), _c("Mumbai", 92e6, 1e6, tiers=(3, 68, 29))])
    d, m = rows["delhi"], rows["mumbai"]
    assert d["rr_m3_pp_2020"] == 157 and d["rr_floor_m2_pp"] == 52 and d["rr_change_pct"] == -25
    assert d["rr_world_pctile"] == 50 and d["rr_india_pctile"] == 75
    assert m["rr_high_pct"] == 29 and "rr_change_pct" not in m


def test_city_rows_skips_missing_volume():
    assert city_rows([_c("Pune", None, 1e6)]) == {}
