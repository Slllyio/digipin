from pipeline.realestate.servicecentres import coords, records

KML = """<kml><Placemark><ExtendedData><SimpleData name="applicant_name">X</SimpleData></ExtendedData>
<Point><coordinates>77.59,12.97,0</coordinates></Point></Placemark>
<Placemark><Point><coordinates> 77.59,12.97</coordinates></Point></Placemark>
<Placemark><Point><coordinates>80.1,13.0</coordinates></Point></Placemark></kml>"""


def test_coords_only_and_dedupe_in_bbox():
    pts = coords(KML)
    assert pts == [(77.59, 12.97), (77.59, 12.97), (80.1, 13.0)]
    recs = list(records([("csc", pts), ("grama_one", pts[:1])], (77.3, 12.7, 77.9, 13.2)))
    assert recs == [{"lat": 12.97, "lng": 77.59, "csc": 1}, {"lat": 12.97, "lng": 77.59, "grama_one": 1}]
    assert all("applicant_name" not in r for r in recs)
