from pipeline.realestate.tbcare import records


def test_records_clip_to_bbox_and_dedupe_per_kind():
    kp = [("tb_units", [(77.60, 12.90, {}), (77.60, 12.90, {}), (78.5, 12.9, {})]), ("tb_tests", [(77.60, 12.90, {})])]
    recs = list(records(kp, (77.45, 12.83, 77.78, 13.14)))
    assert sorted(k for r in recs for k in r if k not in ("lat", "lng")) == ["tb_tests", "tb_units"]
