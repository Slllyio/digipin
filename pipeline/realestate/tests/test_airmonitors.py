from pipeline.realestate import airmonitors


def test_merge_dedupes_air_stations_and_keeps_noise():
    kp = [("air", [(77.6000, 12.9000, {}), (77.7000, 12.9500, {})]),
          ("continuous", [(77.6010, 12.9005, {})]),
          ("noise", [(77.6001, 12.9001, {})])]
    got = airmonitors.merge(kp, (77.3, 12.7, 77.9, 13.2))
    kinds = sorted(k for *_, k in got)
    assert kinds == ["air", "continuous", "noise"]


def test_records_split_kinds():
    recs = list(airmonitors.records([(77.6, 12.9, "continuous"), (77.7, 12.95, "air"), (77.6, 12.9, "noise")]))
    assert recs[0]["continuous"] == 1 and recs[1]["continuous"] == 0 and recs[2] == {"lat": 12.9, "lng": 77.6, "noise_monitors": 1}
