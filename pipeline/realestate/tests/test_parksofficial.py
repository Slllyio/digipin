from pipeline.realestate import parksofficial as P


def test_ring_area_of_a_100_m_square():
    d_lat, d_lng = 100 / 110_574, 100 / (111_320 * 0.9563)   # cos(17 deg)
    ring = [(78.0, 17.0), (78.0 + d_lng, 17.0), (78.0 + d_lng, 17.0 + d_lat), (78.0, 17.0 + d_lat)]
    assert abs(P.ring_area_m2(ring) - 10_000) < 100


def test_records_points_dedupe_and_polygons_carry_area():
    pts = """<kml><Placemark><Point><coordinates>78.5,17.4</coordinates></Point></Placemark>
    <Placemark><Point><coordinates>78.50001,17.40001</coordinates></Point></Placemark></kml>"""
    assert list(P.records("parks", pts)) == [{"lat": 17.4, "lng": 78.5, "parks": 1}]
    poly = """<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>73.8,18.5 73.801,18.5 73.801,18.501 73.8,18.501 73.8,18.5</coordinates>
    </LinearRing></outerBoundaryIs></Polygon></Placemark></kml>"""
    (rec,) = P.records("parks", poly)
    assert rec["parks"] == 1 and 10_000 < rec["park_m2"] < 13_000
