from pipeline.realestate import bdalayouts


def pm(name, code, x0):
    return (f'<Placemark><ExtendedData><SchemaData><SimpleData name="LAYOUT_NAME">{name}</SimpleData>'
            f'<SimpleData name="LayoutCode">{code}</SimpleData></SchemaData></ExtendedData><Polygon><outerBoundaryIs><LinearRing>'
            f'<coordinates>{x0},12.9 {x0 + 0.01},12.9 {x0 + 0.01},12.91 {x0},12.91 {x0},12.9</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>')


def test_parts_of_a_layout_share_name_code_and_total_area():
    kml = "<kml><Document>" + pm("FURTHER EXTENSTION OF BANASHANKARI 6TH STAGE", 61, 77.5) + pm("FURTHER EXTENSTION OF BANASHANKARI 6TH STAGE", 61, 77.52) \
        + pm("HSR", "x", 77.6) + "</Document></kml>"
    got = bdalayouts.layouts(kml)
    assert len(got) == 2
    assert got[0][0] == "Further Extension Of Banashankari 6th Stage" and got[0][1] == 61
    assert got[0][3] == got[1][3] and 2.2 < got[0][3] < 2.6
