from pipeline.realestate import roadplan as rp

KML = """<kml><Placemark><ExtendedData><SimpleData name="RR_WIDTH_P">30</SimpleData><SimpleData name="RR_TP_TYPE">C</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>77.5742,12.9765 77.5742,12.9775</coordinates></LineString></MultiGeometry></Placemark>
<Placemark><ExtendedData><SimpleData name="RR_WIDTH_P">12</SimpleData><SimpleData name="RR_TP_TYPE">W</SimpleData></ExtendedData>
<LineString><coordinates>77.5742,12.9765 77.5752,12.9765</coordinates></LineString></Placemark></kml>"""


def test_roads_and_accumulate():
    rs = list(rp.roads(KML))
    assert [(w, link) for _, w, link in rs] == [(30.0, True), (12.0, False)]
    acc = rp.accumulate(rs, {})
    total = sum(r[0] for r in acc.values())
    assert abs(total - 111.3 - 108.5) < 1.5
    assert abs(sum(r[1] for r in acc.values()) - 111.3) < 0.5 and abs(sum(r[2] for r in acc.values()) - 111.3) < 0.5
    assert max(r[3] for r in acc.values()) == 30.0
