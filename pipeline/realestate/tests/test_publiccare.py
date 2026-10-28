from pipeline.realestate import publiccare


def test_records_count_each_centre_once_per_kind():
    kp = [("primary", [(77.6014, 13.0016, {}), (77.60141, 13.00161, {})]), ("primary", [(77.60142, 13.00162, {})]),
          ("maternity", [(77.6014, 13.0016, {}), (0.0, 0.0, {})])]
    recs = list(publiccare.records(kp))
    assert recs == [{"lat": 13.0016, "lng": 77.6014, "primary": 1}, {"lat": 13.0016, "lng": 77.6014, "maternity": 1}]


def test_points_reads_geojson():
    text = '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[77.6,13.0]},"properties":{"a":1}}]}'
    assert publiccare.points("x.geojson", text) == [(77.6, 13.0, {"a": 1})]
