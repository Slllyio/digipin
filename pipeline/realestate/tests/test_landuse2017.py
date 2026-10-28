from pipeline.realestate import landuse2017 as lu


def test_classify_maps_ksrsac_classes():
    c = lambda **kw: lu.classify(kw)
    assert c(ULU="Residential_Area", LULC_Desc_1="Built-up") == "residential"
    assert c(ULU="Commercial Area") == "commercial"
    assert c(ULU="Layout", LULC_Desc_3="Layout") == "vacant"
    assert c(ULU="Vacant Land") == "vacant"
    assert c(ULU="Road", LULC_Desc_2="Transportation") == "road"
    assert c(LULC_Desc_1="Water bodies", LULC_Desc_2="Tank") == "water"
    assert c(LULC_Desc_2="Educational", LULC_Desc_3="School / Colleges") == "civic"
    assert c(LULC_Desc_2="Crop land") == "farm"
    assert c(LULC_Desc_2="Recreational", LULC_Desc_3="Park / Garden") == "green"
    assert c(LULC_Desc_1="Others") is None


def test_polygons_and_sample_points():
    kml = ('<Placemark><SimpleData name="ULU">Vacant Land</SimpleData><Polygon><outerBoundaryIs><LinearRing><coordinates>'
           '77.5,12.9 77.51,12.9 77.51,12.91 77.5,12.91</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>')
    (cls, g), = lu.polygons(kml)
    assert cls == "vacant" and g["coordinates"][0][0][0] == g["coordinates"][0][0][-1]
    pts = list(lu.sample_points(["4P3JK37"], grid=2))
    assert len(pts) == 4 and all(p[0] == "4P3JK37" for p in pts)
