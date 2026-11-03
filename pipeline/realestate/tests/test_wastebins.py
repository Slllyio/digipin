from pipeline.realestate import wastebins as wb


def test_records_dedupe_and_clip():
    recs = list(wb.records([(80.2, 13.0, {}), (80.20001, 13.00001, {}), (77.6, 12.9, {})], (80.0, 12.8, 80.4, 13.3)))
    assert recs == [{"lat": 13.0, "lng": 80.2, "bins": 1}]
