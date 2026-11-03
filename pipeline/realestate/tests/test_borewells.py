from pipeline.realestate import borewells as bw


def test_records_dedupe_and_clip():
    recs = list(bw.records([(77.6, 12.9, {}), (77.60001, 12.90001, {}), (80.0, 13.0, {}), (77.7, 13.0, {})]))
    assert [(r["lng"], r["lat"]) for r in recs] == [(77.6, 12.9), (77.7, 13.0)]
