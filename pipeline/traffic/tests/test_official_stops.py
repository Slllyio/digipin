from pipeline.traffic import official_stops


def test_records_drop_duplicates_and_points_outside_india():
    pts = [(72.85, 19.10, {}), (72.850001, 19.100001, {}), (72.86, 19.11, {}), (0.0, 0.0, {})]
    recs = list(official_stops.records(pts))
    assert recs == [{"lat": 19.10, "lng": 72.85, "stops": 1}, {"lat": 19.11, "lng": 72.86, "stops": 1}]
