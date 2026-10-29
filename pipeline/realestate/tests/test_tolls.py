from pipeline.realestate import tolls as t

KML = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><ExtendedData><SchemaData><SimpleData name="plaza_code">1</SimpleData><SimpleData name="plaza_type">Toll</SimpleData>
<SimpleData name="plaza_sub_type">National</SimpleData><SimpleData name="lat">12.0</SimpleData><SimpleData name="long">77.0</SimpleData>
<SimpleData name="carjeepvan_sj">100</SimpleData><SimpleData name="carjeepvan_mp">2500</SimpleData><SimpleData name="carjeepvan_reg">NA</SimpleData></SchemaData></ExtendedData></Placemark>
<Placemark><ExtendedData><SchemaData><SimpleData name="plaza_code">2</SimpleData><SimpleData name="plaza_type">Toll</SimpleData>
<SimpleData name="plaza_sub_type">National</SimpleData><SimpleData name="lat">12.1</SimpleData><SimpleData name="long">77.0</SimpleData></SchemaData></ExtendedData></Placemark>
<Placemark><ExtendedData><SchemaData><SimpleData name="plaza_code">3</SimpleData><SimpleData name="plaza_type">Toll</SimpleData>
<SimpleData name="plaza_sub_type">State</SimpleData><SimpleData name="lat">12.2</SimpleData><SimpleData name="long">77.0</SimpleData></SchemaData></ExtendedData></Placemark>
</Document></kml>"""


def test_plazas_drop_feeless_nhai_keep_state():
    p = t.plazas(KML)
    assert [x[2]["code"] for x in p] == ["1", "3"]
    assert p[0][2]["car"] == 100 and p[0][2]["car_month"] == 2500 and p[0][2]["car_local"] is None


def test_block_rows_nearest_and_count():
    rows = t.block_rows([("a", 12.01, 77.0), ("b", 12.19, 77.0)], t.plazas(KML), near_km=5)
    assert rows["a"]["toll_car"] == 100 and rows["a"]["toll_km"] == 1.1 and rows["a"]["tolls_25km"] == 1
    assert "toll_car" not in rows["b"] and rows["b"]["toll_code"] == 3
