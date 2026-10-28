from pipeline.realestate import waterlines as wl

KML = """<kml><Placemark><LineString><tessellate>1</tessellate><coordinates>
77.5742,12.9765,0 77.5742,12.9775,0 </coordinates></LineString></Placemark></kml>"""


def test_records_split_mains():
    small, main = list(wl.records(KML, False)), list(wl.records(KML, True))
    assert abs(sum(r["pipe_m"] for r in small) - 111.3) < 0.5 and not any("main_m" in r for r in small)
    assert abs(sum(r["main_m"] for r in main) - 111.3) < 0.5
