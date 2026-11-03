from pipeline.realestate.earthbounds import city_rows


def _c(name, mx, country="India", pop=2_000_000, **flags):
    return {"name": name, "country": country, "pop": pop, "max": mx, "min": 1, **flags}


def test_city_rows_flags_and_rank():
    rows = city_rows([_c("Mumbai", 3, slr=2, gwa=0), _c("New Delhi", 5, gwa=1), _c("Paris", 1, country="France")])
    m = rows["mumbai"]
    assert m["eb_max"] == 3 and m["eb_slr"] == 1 and m["eb_gwa"] == 0 and "eb_bio" not in m
    assert m["eb_world_pctile"] == 50 and rows["delhi"]["eb_world_pctile"] == 83


def test_city_rows_skips_missing():
    assert city_rows([_c("Pune", None)]) == {}
