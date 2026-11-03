from pipeline.realestate import floodzones

KML = ('<Placemark><ExtendedData><SimpleData name="CATEGORY">Very High</SimpleData></ExtendedData><Polygon><outerBoundaryIs><LinearRing>'
       '<coordinates>80.2,13.0,0 80.21,13.0,0 80.21,13.01,0 80.2,13.0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>')


def test_polygons_read_category():
    (cat, geom), = list(floodzones.polygons(KML))
    assert cat == "very high" and geom["type"] == "MultiPolygon"
    assert floodzones.CLASSES[cat] == 5


def test_return_period_names():
    assert floodzones.RP_NAME.search("Chennai Flows 5 Year Return Period").group(1) == "5"
    assert floodzones.RP_NAME.search("Chennai Flows 100 Years Return Period").group(1) == "100"


def test_flood_rp_is_most_frequent_covering_a_quarter(monkeypatch):
    import pipeline.realestate.landuse2017 as lu
    cover = {5: {"A": 10}, 25: {"A": 30, "B": 40}, 100: {"A": 90, "B": 90}}
    calls = iter([cover[5], cover[25], cover[100], {}])
    monkeypatch.setattr(lu, "shares", lambda cells, polys: {c: {"x_pct": v} for c, v in next(calls).items()})
    rows = floodzones.return_rows(["A", "B", "C"], {5: [("low", None)], 25: [("low", None)], 100: [("high", None)]})
    assert rows["A"]["flood_rp_years"] == 25 and rows["B"]["flood_rp_years"] == 25
    assert "C" not in rows
