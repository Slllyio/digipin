from pipeline.realestate.recycling import SOURCES, records


def test_records_clip_and_dedupe_per_kind():
    kp = [("recovery_centres", [(80.27, 13.08), (80.27001, 13.08)]), ("processing_sites", [(80.27, 13.08), (79.0, 13.0)])]
    recs = list(records(kp, (80.0, 12.8, 80.4, 13.3)))
    assert recs == [{"lat": 13.08, "lng": 80.27, "recovery_centres": 1}, {"lat": 13.08, "lng": 80.27, "processing_sites": 1}]
    assert {k for s in SOURCES.values() for k, *_ in s} == {"recovery_centres", "processing_sites"}
