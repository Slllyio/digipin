from pipeline.realestate import landmarks as lm


def test_parse_keeps_one_row_per_item():
    b = [{"m": {"value": "http://www.wikidata.org/entity/Q1"}, "c": {"value": "Point(77.2 28.6)"}, "sl": {"value": "12"}},
         {"m": {"value": "http://www.wikidata.org/entity/Q1"}, "c": {"value": "Point(77.2 28.6)"}, "sl": {"value": "12"}}]
    assert lm.parse(b) == [("Q1", 28.6, 77.2, 12)]


def test_rows_sum_pull_and_keep_the_top(monkeypatch):
    from pipeline.cells import store
    monkeypatch.setattr(store, "cell_code", lambda level, lat, lng: "A")
    rows = lm.rows_for([("Q1", 1, 1, 10), ("Q2", 1, 1, 30)])
    assert rows == [{"digipin": "A", "landmarks": 2, "pull": 40, "top_pull": 30}]
