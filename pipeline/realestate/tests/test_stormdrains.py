from pipeline.realestate import stormdrains as sd

GCC = """<kml><Placemark><ExtendedData><SimpleData name="COVER">Yes</SimpleData><SimpleData name="DRAIN_DETL">Closed</SimpleData>
</ExtendedData><LineString><coordinates>80.2707,13.0827 80.2707,13.0837</coordinates></LineString></Placemark>
<Placemark><ExtendedData><SimpleData name="COVER">No</SimpleData><SimpleData name="DRAIN_DETL">Open</SimpleData></ExtendedData>
<LineString><coordinates>80.2717,13.0827 80.2717,13.0837</coordinates></LineString></Placemark></kml>"""

PMC = """<kml><Placemark id="a.1"><ExtendedData><SimpleData name="category">Road_Sewer</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>73.8567,18.5204 73.8567,18.5214</coordinates></LineString></MultiGeometry></Placemark>
<Placemark id="a.2"><ExtendedData><SimpleData name="category">Storm water drains</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>73.8567,18.5214 73.8567,18.5224</coordinates></LineString></MultiGeometry></Placemark>
<Placemark id="a.3"><ExtendedData><SimpleData name="category">Nalla</SimpleData></ExtendedData>
<MultiGeometry><LineString><coordinates>73.8577,18.5214 73.8577,18.5224</coordinates></LineString></MultiGeometry></Placemark></kml>"""


def test_gcc_covered_drains():
    ls = list(sd.drains(GCC))
    assert [(k, c) for _, k, c in ls] == [("swd", True), ("swd", False)]
    recs = list(sd.records(ls))
    assert abs(sum(r.get("swd_m", 0) for r in recs) - 222.6) < 1 and abs(sum(r.get("closed_m", 0) for r in recs) - 111.3) < 0.5


def test_pmc_skips_sewers_and_splits_nalas():
    ls = list(sd.drains(PMC))
    assert [k for _, k, _ in ls] == ["swd", "nalla"]
    recs = list(sd.records(ls))
    assert abs(sum(r.get("nalla_m", 0) for r in recs) - 111.3) < 0.5
