from pipeline.realestate.climatetwin import analogues, city_rows, distance


def _c(i, name, now, fut=None, country="India", pop=2_000_000):
    return {"id": i, "name": name, "country": country, "pop": pop, "t1970": now[0], "now": now, "fut85": fut or now, "fut45": fut or now}


def test_distance_scales_by_spread():
    assert distance([1, 10], [2, 30], [1, 10]) == 5 ** 0.5


def test_analogues_excludes_self_and_country():
    cand = [_c(1, "A", [25, 700, 600, 1.3]), _c(2, "B", [26, 650, 660, 1.3]), _c(3, "C", [26.5, 600, 650, 1.2], country="Pakistan")]
    assert analogues([26, 650, 660, 1.3], cand, [1, 100, 100, 0.1], exclude={2})[0] in (1, 3)
    assert analogues([26, 650, 660, 1.3], cand, [1, 100, 100, 0.1], country="India")[0] == 3


def test_city_rows_finds_twin():
    cs = [_c(10, "New Delhi", [25.1, 683, 695, 1.3], [26.3, 645, 666, 1.3]), _c(11, "Meerut", [26.2, 650, 670, 1.3]),
          _c(12, "Lahore", [26.0, 500, 700, 1.0], country="Pakistan"), _c(13, "Oslo", [6, 800, 600, 0.3], country="Norway")]
    rows, names = city_rows(cs)
    d = rows["delhi"]
    assert d["ct_twin_id"] == 11 and d["ct_abroad_id"] == 12
    assert names[11] == "Meerut, India" and d["ct_temp_2030"] == 26.3
