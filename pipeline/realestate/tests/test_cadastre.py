from pipeline.realestate import cadastre


def square(lng, lat, d):
    return {"type": "Polygon", "coordinates": [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]]}


def test_parcel_area_and_centre():
    a, c = cadastre.parcel(square(78.5, 17.4, 0.001))
    assert 11000 < a < 12500
    assert abs(c[0] - 78.5005) < 1e-6 and abs(c[1] - 17.4005) < 1e-6


def test_parcel_rows_median_and_strips():
    feats = [(False, square(78.5, 17.4, 0.0002)), (False, square(78.5003, 17.4, 0.0004)), (False, square(78.5006, 17.4, 0.0002)),
             (True, square(78.5009, 17.4, 0.0002))]
    rows = cadastre.parcel_rows(feats, strips=True)
    (r,) = rows.values()
    assert r["parcels"] == 3 and 400 < r["parcel_m2"] < 500
    assert sum(x["parcels"] for x in cadastre.parcel_rows(feats).values()) == 4


def test_kml_features_flags_kharab_only_in_bengaluru():
    kml = ('<Placemark><ExtendedData><SimpleData name="Category">Tank</SimpleData></ExtendedData><MultiGeometry><Polygon><outerBoundaryIs>'
           '<LinearRing><coordinates>77.6,12.9,0 77.601,12.9,0 77.601,12.901,0 77.6,12.9,0</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry></Placemark>')
    assert [p for p, _ in cadastre.kml_features(kml, "bengaluru")] == [True]
    assert [p for p, _ in cadastre.kml_features(kml, "pune")] == [False]


def test_govt_flag():
    assert all(cadastre.GOVT.match(s) for s in ("GOVT", "Govt", "DEPT", "GRYD", "GOVT,GHMC"))
    assert not cadastre.GOVT.match("priv") and not cadastre.GOVT.match("PRIVATE")
