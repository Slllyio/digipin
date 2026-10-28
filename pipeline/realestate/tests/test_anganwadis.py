from pipeline.realestate import anganwadis


def test_records_clip_to_box_and_drop_duplicates():
    pts = [(78.5, 17.4, {}), (78.500001, 17.400001, {}), (79.9, 17.4, {}), (78.4, 17.3, {})]
    recs = list(anganwadis.records(pts, (78.0, 17.0, 79.0, 18.0)))
    assert recs == [{"lat": 17.4, "lng": 78.5, "centres": 1}, {"lat": 17.3, "lng": 78.4, "centres": 1}]
