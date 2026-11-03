from pipeline.realestate import sewers as sw

KML = """<kml><Placemark><ExtendedData><SimpleData name="Diameter">300</SimpleData></ExtendedData>
<LineString><coordinates>77.5742,12.9765 77.5742,12.9775</coordinates></LineString></Placemark>
<Placemark><ExtendedData><SimpleData name="Diameter">150</SimpleData></ExtendedData>
<LineString><coordinates>77.5742,12.9765</coordinates></LineString></Placemark></kml>"""


def test_lines_and_pieces():
    ls = list(sw.lines(KML))
    assert len(ls) == 1 and ls[0][1] == 300.0 and ls[0][2] is None
    ps = list(sw.pieces(ls[0][0]))
    assert len(ps) == 5 and abs(sum(p[2] for p in ps) - 111.3) < 0.5


def test_accumulate_trunk_length():
    acc = sw.accumulate(sw.lines(KML), {})
    assert abs(sum(r[0] for r in acc.values()) - 111.3) < 0.5
    assert sum(r[1] for r in acc.values()) == sum(r[0] for r in acc.values())


CMWSSB = """<kml><Placemark><ExtendedData><SimpleData name="size_of_pipe_mm">2</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>80.2707,13.0827 80.2707,13.0837</coordinates></LineString></MultiGeometry></Placemark>
<Placemark><ExtendedData><SimpleData name="size_of_pipe_mm">11</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>80.2707,13.0837 80.2707,13.0847</coordinates></LineString></MultiGeometry></Placemark></kml>"""


def test_cmwssb_size_codes():
    ls = list(sw.lines(CMWSSB))
    assert [d for _, d, _ in ls] == [150, 600]
    acc = sw.accumulate(ls, {})
    assert abs(sum(r[1] for r in acc.values()) - 111.3) < 0.5


PMC = """<kml><Placemark id="pmc_storm_water_drains.1"><ExtendedData><SimpleData name="category">Road_Sewer</SimpleData>
<SimpleData name="drainaige_">Collection_Sewer</SimpleData><SimpleData name="pipeline_d">300</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>73.8567,18.5204 73.8567,18.5214</coordinates></LineString></MultiGeometry></Placemark>
<Placemark id="pmc_storm_water_drains.2"><ExtendedData><SimpleData name="category">Nalla_Sewer</SimpleData>
<SimpleData name="drainaige_">Trunk_Sewer</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>73.8567,18.5214 73.8567,18.5224</coordinates></LineString></MultiGeometry></Placemark>
<Placemark id="pmc_storm_water_drains.3"><ExtendedData><SimpleData name="category">Storm water drains</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>73.8577,18.5214 73.8577,18.5224</coordinates></LineString></MultiGeometry></Placemark></kml>"""


def test_pmc_sewers_only_and_role_decides_trunk():
    ls = list(sw.lines(PMC))
    assert [t for _, _, t in ls] == [False, True]
    acc = sw.accumulate(ls, {})
    assert abs(sum(r[0] for r in acc.values()) - 222.6) < 1 and abs(sum(r[1] for r in acc.values()) - 111.3) < 0.5


def test_hull_and_hmwssb_lines():
    h = sw.hull([(0, 0), (2, 0), (2, 2), (0, 2), (1, 1)])
    assert len(h) == 4 and sw.inside(h, 1, 1) and not sw.inside(h, 3, 1)
    doc = {"features": [{"geometry": {"type": "MultiLineString", "coordinates": [[[233354.5, 1922304.5], [233339.0, 1922280.1]]]},
                         "properties": {"SP_PIPE_DI": 200.0, "SECTION_NA": "AZAMPURA"}}]}
    (pts, diam, trunk, sec), = sw.hmwssb_lines(doc)
    assert diam == 200.0 and trunk is None and sec == "AZAMPURA"
    assert 78.4 < pts[0][0] < 78.6 and 17.3 < pts[0][1] < 17.45
