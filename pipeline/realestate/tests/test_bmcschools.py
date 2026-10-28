from pipeline.realestate import bmcschools as bs


def test_records_count_each_site_once():
    recs = list(bs.records({"municipal": [(72.85, 19.22, {}), (72.85001, 19.22001, {})], "aided": [(72.85, 19.22, {}), (0, 0, {})]}))
    assert [r["schools"] for r in recs] == [1, 0, 0]
    assert sum(r.get("municipal", 0) for r in recs) == 2 and sum(r.get("aided", 0) for r in recs) == 1
