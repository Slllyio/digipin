from pipeline.realestate.tankbeds import parts, records, tanks

PM = """<Placemark><ExtendedData><SchemaData><SimpleData name="Base_Syno">12</SimpleData><SimpleData name="WBS_2023">{s23}</SimpleData>
<SimpleData name="WBS_2014">{s14}</SimpleData><SimpleData name="2023_class">{cls}</SimpleData><SimpleData name="ID">{id}</SimpleData></SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>{x},17.40,0 {x2},17.40,0 {x2},17.41,0 {x},17.41,0 {x},17.40,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"""


def kml():
    return "<kml>" + "".join([
        PM.format(s23="Partially Encroached - Built-up", s14="Live", cls="Built Up", id="1", x=78.40, x2=78.401),
        PM.format(s23="Partially Encroached - Built-up", s14="Live", cls="Waterbody", id="1", x=78.401, x2=78.41),
        PM.format(s23="Totally Encroached - Built-up", s14="Totally Encroached - Built-up", cls="Built Up", id="2", x=78.45, x2=78.46),
        PM.format(s23="Live", s14="Live", cls="Waterbody", id="3", x=78.50, x2=78.51),
    ]) + "</kml>"


def test_parts_and_tanks():
    ps = parts(kml())
    assert len(ps) == 4 and ps[0][1] and not ps[1][1]
    tk = sorted(tanks(ps))
    assert len(tk) == 3
    # tank 1 placed on its larger water part, worsened since 2014; tank 2 lost; tank 3 live
    assert tk[0][0] > 78.401 and tk[0][2:] == (0, 0, 1)
    assert tk[1][2:] == (0, 1, 0) and tk[2][2:] == (1, 0, 0)


def test_records_drop_outside_bbox():
    recs = list(records({"ABC": {"tankbed_pct": 10.0}}, [(78.4, 17.4, 1, 0, 0), (80.0, 17.4, 0, 1, 0)], (78.3, 17.3, 78.6, 17.55)))
    assert recs[0] == {"digipin": "ABC", "tankbed_pct": 10.0} and len(recs) == 2 and recs[1]["tanks_live"] == 1
