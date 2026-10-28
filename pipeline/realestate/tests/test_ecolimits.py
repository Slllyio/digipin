import numpy as np

from pipeline.realestate import ecolimits as E


def test_between_splits_coast_canal_and_land():
    # 2 km x 2.4 km at 20 m: the CRZ line at column 70, a canal walled at columns 20 and 23, the sea to the east.
    wall = np.zeros((100, 120), bool)
    wall[:, 70] = True
    wall[:, 20] = wall[:, 23] = True
    zone, land = E.between(wall, px_m=20)
    assert zone[:, 21:23].all()                        # narrow canal pocket
    assert not zone[:, 5].any()                        # inland
    assert not zone[:, 45].any() and land[:, 45].all()  # 920 m wide pocket between two zones is ordinary land
    assert zone[:, 80].all() and land[:, 80].all()      # 200 m seaward of the line
    assert not zone[:, 110].any() and not land[:, 110].any()  # 800 m seaward: open sea


def test_kml_polygons_reads_holes():
    kml = """<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>77,12 78,12 78,13 77,12</coordinates></LinearRing></outerBoundaryIs>
    <innerBoundaryIs><LinearRing><coordinates>77.5,12.2 77.6,12.2 77.6,12.3 77.5,12.2</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark></kml>"""
    (outer, holes), = E.kml_polygons(kml)
    assert outer[0] == (77.0, 12.0) and len(holes) == 1
