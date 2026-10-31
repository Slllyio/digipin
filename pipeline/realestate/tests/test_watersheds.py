from pipeline.realestate import watersheds

SQ = [[[77.5, 12.9], [77.51, 12.9], [77.51, 12.91], [77.5, 12.91], [77.5, 12.9]]]


def test_micro_reads_codes_area_in_hectares_and_wraps_polygons():
    doc = {"features": [
        {"properties": {"MWS": "4D7D7a1", "WATERSHED": "4D7D7", "AREA": "353.965"}, "geometry": {"type": "Polygon", "coordinates": SQ}},
        {"properties": {"MWS": "4D7D7a2", "WATERSHED": "4D7D7", "AREA": "n/a"}, "geometry": {"type": "MultiPolygon", "coordinates": [SQ]}},
        {"properties": {"MWS": ""}, "geometry": {"type": "Polygon", "coordinates": SQ}},
    ]}
    got = watersheds.micro(doc)
    assert [(m[0], m[1], m[3]) for m in got[:1]] == [("4D7D7a1", "4D7D7", 3.54)]
    assert got[0][2]["type"] == "MultiPolygon" and len(got) == 2
    assert 1.1 < got[1][3] < 1.3   # no AREA: measured from the outline
