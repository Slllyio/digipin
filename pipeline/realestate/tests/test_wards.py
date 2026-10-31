from pipeline.realestate import wards


def test_num_name_and_label():
    assert wards._num_name("48 RAMOL HATHIJAN") == ("48", "RAMOL HATHIJAN")
    assert wards._num_name("Ward 91 Khairatabad") == ("91", "Khairatabad")
    assert wards.label("12", "Saket") == "12 Saket" and wards.label(None, "A") == "A" and wards.label("", None) is None


def test_delhi_charges_get_their_own_body():
    assert wards._delhi({"Ward_No": "NDMC_3", "Ward_Name": "NDMC CHARGE 3"}) == ("3", "NDMC charge 3", None, "NDMC")
    assert wards._delhi({"Ward_No": "160", "Ward_Name": "AMAR COLONY"}) == ("160", "Amar Colony", None)


def test_closed_rings():
    g = wards.closed({"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 1]]]})
    assert g["coordinates"] == [[[0, 0], [1, 0], [1, 1], [0, 0]]]


def test_kml_features_and_lgd_names():
    kml = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><ExtendedData><SchemaData>
    <SimpleData name="sourcewardcode">12</SimpleData><SimpleData name="sourcewardname">NARODA</SimpleData></SchemaData></ExtendedData>
    <MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry>
    </Placemark></Document></kml>"""
    f = wards.kml_features(kml)
    assert f[0]["geometry"]["coordinates"] == [[[[0, 0], [1, 0], [1, 1], [0, 0]]]]
    assert wards._lgd(f[0]["properties"]) == ("12", "Naroda", None)
    assert wards._lgd({"sourcewardcode": "1", "ward_lgd_name": "Gurgaon (M Cl ) - Ward No.1"}) == ("1", "", None)
