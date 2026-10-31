from pipeline.realestate.landslides import records


def test_records_parse_deaths_and_skip_bad_points():
    feats = [{"properties": {"latitude": 19.1, "longitude": 72.9, "fatality_c": "3"}},
             {"properties": {"latitude": 19.2, "longitude": 72.8, "fatality_c": None}},
             {"properties": {"latitude": None, "longitude": 72.8}}]
    recs = list(records(feats))
    assert [r["landslide_deaths"] for r in recs] == [3, 0]
