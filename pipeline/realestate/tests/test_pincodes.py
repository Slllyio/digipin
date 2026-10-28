from pipeline.realestate import pincodes

KML = """<kml><Document><Placemark><ExtendedData><SchemaData>
<SimpleData name="Pincode">560001</SimpleData><SimpleData name="Office_Name">Bangalore  GPO </SimpleData>
<SimpleData name="Division">Bangalore East </SimpleData></SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>77.0,12.0 77.01,12.0 77.01,12.01 77.0,12.01 77.0,12.0</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark><Placemark><ExtendedData><SchemaData><SimpleData name="Pincode">n/a</SimpleData></SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>77.0,12.0 77.01,12.0 77.01,12.01 77.0,12.0</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark></Document></kml>"""


def test_pins_reads_code_names_and_area():
    got = pincodes.pins(KML)
    assert len(got) == 1
    pin, office, division, _, km2, b = got[0]
    assert (pin, office, division) == (560001, "Bangalore GPO", "Bangalore East")
    assert 1.1 < km2 < 1.3   # about 1.09 km x 1.11 km
    assert b == (77.0, 12.0, 77.01, 12.01)


def test_ring_area_ignores_degenerate():
    assert pincodes.ring_km2([(0, 0), (1, 1)]) == 0.0
