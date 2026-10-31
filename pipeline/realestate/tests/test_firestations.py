from pipeline.realestate import firestations as fs


def test_stations_dedupe_and_clip():
    pts = [(77.56, 12.86, {}), (77.5601, 12.8601, {}), (75.67, 16.16, {}), (0.0, 0.0, {}), (77.70, 13.00, {})]
    out = fs.stations(pts, (77.45, 12.83, 77.78, 13.14))
    assert out == [(77.56, 12.86), (77.70, 13.00)]
    assert len(fs.stations(pts)) == 3
