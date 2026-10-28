from pipeline.realestate import stps

CSV = """STPId,STPName,Latitude,Longitude,PlantType,TreatmentCapacity (KLD),Status
9,Hebbal  60MLD,12.940545,77.654822,Sewage Treatment Plant       ,60000,TRUE
10,No size,13.0471,77.662156,Sewage Treatment Plant       ,,TRUE
"""

KML = """<kml><Placemark id="a.1"><ExtendedData><SimpleData name="Unique_ID">X1</SimpleData><SimpleData name="STP_Capaci">40</SimpleData>
<SimpleData name="Category">Existing STP</SimpleData></ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>
73.95,18.54 73.96,18.54 73.96,18.55 73.95,18.54</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark id="a.2"><ExtendedData><SimpleData name="Unique_ID">X1</SimpleData></ExtendedData><Polygon><outerBoundaryIs><LinearRing>
<coordinates>73.95,18.54 73.96,18.54 73.96,18.55 73.95,18.54</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark id="a.3"><ExtendedData><SimpleData name="Unique_ID">X2</SimpleData><SimpleData name="STP_Capaci">7</SimpleData>
<SimpleData name="Category">Proposed STP</SimpleData></ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>
73.90,18.50 73.91,18.50 73.91,18.51 73.90,18.50</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>"""


def test_bwssb_capacity_in_mld():
    got = list(stps.bwssb(CSV))
    assert [p[2] for p in got] == [60.0, 0.0] and not any(p[3] for p in got)


def test_outlines_dedupe_and_proposed():
    got = list(stps.outlines(KML))
    assert [(p[2], p[3]) for p in got] == [(40.0, False), (7.0, True)]
    recs = list(stps.records(got))
    assert recs[0]["stps"] == 1 and recs[1] == {"lat": recs[1]["lat"], "lng": recs[1]["lng"], "proposed": 1}
