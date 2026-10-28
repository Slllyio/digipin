from pipeline.realestate import sewers as sw

KML = """<kml><Placemark><ExtendedData><SimpleData name="Diameter">300</SimpleData></ExtendedData>
<LineString><coordinates>77.5742,12.9765 77.5742,12.9775</coordinates></LineString></Placemark>
<Placemark><ExtendedData><SimpleData name="Diameter">150</SimpleData></ExtendedData>
<LineString><coordinates>77.5742,12.9765</coordinates></LineString></Placemark></kml>"""


def test_lines_and_pieces():
    ls = list(sw.lines(KML))
    assert len(ls) == 1 and ls[0][1] == 300.0
    ps = list(sw.pieces(ls[0][0]))
    assert len(ps) == 5 and abs(sum(p[2] for p in ps) - 111.3) < 0.5


def test_accumulate_trunk_length():
    acc = sw.accumulate(sw.lines(KML), {})
    assert abs(sum(r[0] for r in acc.values()) - 111.3) < 0.5
    assert sum(r[1] for r in acc.values()) == sum(r[0] for r in acc.values())
