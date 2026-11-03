from pipeline.realestate import streetlights as sl

KML = """<kml><Document>
<Placemark><ExtendedData><SchemaData><SimpleData name="Type">LED 65W</SimpleData></SchemaData></ExtendedData>
<Point><coordinates>77.642205,12.8510264</coordinates></Point></Placemark>
<Placemark><ExtendedData><SchemaData><SimpleData name="Type">SV</SimpleData></SchemaData></ExtendedData>
<Point><coordinates>77.642205,12.8510264</coordinates></Point></Placemark>
<Placemark><ExtendedData><SchemaData><SimpleData name="Type">SVL250</SimpleData></SchemaData></ExtendedData>
<Point><coordinates>77.6431,12.8512</coordinates></Point></Placemark>
<Placemark><Point><coordinates>0,0</coordinates></Point></Placemark>
</Document></kml>"""


def test_poles_dedupe_and_led():
    pts = sl.poles(KML)
    assert pts == [(77.642205, 12.8510264, True), (77.6431, 12.8512, False)]
    assert list(sl.records(pts))[0] == {"lat": 12.8510264, "lng": 77.642205, "poles": 1, "led": 1}
