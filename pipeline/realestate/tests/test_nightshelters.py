from pipeline.realestate.nightshelters import kind, placemarks, records

KML = """<kml><Placemark><SimpleData name="COORDINATO">Someone 9999999999</SimpleData><SimpleData name="TYPE_SHELT">Women</SimpleData>
<Point><coordinates>80.25,13.05,0</coordinates></Point></Placemark>
<Placemark><SimpleData name="TYPE_SHELT">Special shelter – Men</SimpleData><Point><coordinates>80.20,13.00,0</coordinates></Point></Placemark>
<Placemark><SimpleData name="TYPE_SHELT">Men</SimpleData><Point><coordinates>81.5,13.00,0</coordinates></Point></Placemark></kml>"""


def test_kinds():
    assert kind("Men") == "for_men" and kind("Women") == "for_women" and kind("Girl children") == "for_children"
    assert kind("Elderly Men and Women") == "special" and kind("Transgender") == "special" and kind("Men and Women") == "for_men"


def test_placemarks_keep_type_and_coordinates_only_and_clip():
    pts = placemarks(KML)
    assert pts == [(80.25, 13.05, "for_women"), (80.20, 13.00, "special"), (81.5, 13.00, "for_men")]
    recs = list(records(pts, (80.0, 12.8, 80.4, 13.3)))
    assert len(recs) == 2 and all("Someone" not in str(r) for r in recs)
