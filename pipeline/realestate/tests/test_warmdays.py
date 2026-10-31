from pipeline.realestate.warmdays import city_rows


def _c(name, d10, country="India", pop=2_000_000, d70=9.0):
    return {"name": name, "country": country, "pop": pop, "wd_1970s": d70, "wd_1990s": None, "wd_2010s": d10}


def test_city_rows_ranks_decades():
    rows = city_rows([_c("Mumbai", 27.1), _c("Lucknow", 6.8), _c("Paris", 20.0, country="France")])
    m, l = rows["mumbai"], rows["lucknow"]
    assert m["wd_2010s"] == 27.1 and m["wd_1970s"] == 9.0 and "wd_1990s" not in m
    assert m["wd_world_pctile"] == 83 and m["wd_india_pctile"] == 75 and l["wd_world_pctile"] == 17


def test_city_rows_skips_missing():
    assert city_rows([_c("Pune", None)]) == {}
