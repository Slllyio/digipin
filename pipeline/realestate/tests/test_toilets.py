from pipeline.realestate import toilets

KML = """<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><ExtendedData><SchemaData><SimpleData name="Count_of_F">4</SimpleData><SimpleData name="Count_of_M">6</SimpleData></SchemaData></ExtendedData>
<Point><coordinates>72.85,19.10,0</coordinates></Point></Placemark>
<Placemark><Point><coordinates>0,0</coordinates></Point></Placemark>
<Placemark><Point><coordinates></coordinates></Point></Placemark></Document></kml>"""


def test_kml_points_and_records():
    pts = toilets.kml_points(KML)
    assert len(pts) == 2
    recs = list(toilets.records(pts))
    assert recs == [{"lat": 19.10, "lng": 72.85, "toilets": 1, "seats": 10.0, "seats_women": 4.0}]     # (0, 0) is outside India


def test_records_without_seats():
    assert list(toilets.records([(78.5, 17.4, {"Category": "TOILETS"})])) == [{"lat": 17.4, "lng": 78.5, "toilets": 1}]
