from pipeline.realestate import waterstorage as w

KML = """<kml><Document>
<Placemark><ExtendedData><SchemaData><SimpleData name="capacity_of_oht_ml">60000</SimpleData></SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>80.0,13.0 80.002,13.0 80.002,13.002 80.0,13.0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><ExtendedData><SchemaData><SimpleData name="capacity_of_oht_ml">0.5</SimpleData></SchemaData></ExtendedData>
<Point><coordinates>80.01,13.01</coordinates></Point></Placemark>
</Document></kml>"""


def test_points_centroid_and_litre_fix():
    p = w.points(KML, "capacity_of_oht_ml")
    assert abs(p[0][0] - 13.000667) < 1e-5 and p[0][2] == 0.06 and p[1][2] == 0.5


def test_block_rows_storage_per_resident():
    cells = [("a", 13.0, 80.0), ("b", 13.0, 80.005), ("c", 13.3, 80.0)]
    r = w.block_rows(cells, [1000, 1000, 50], [(13.0, 80.0, 0.06)], [(13.3, 80.0, None)])
    assert r["a"]["ws_l_per_res"] == 30.0 and r["a"]["ws_tanks_2km"] == 1 and r["c"]["ws_ml_2km"] == 0 and r["c"]["ws_fill_km"] == 0
