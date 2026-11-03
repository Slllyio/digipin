from pipeline.realestate import registration as rg


def test_norm_title_and_code():
    assert rg.norm("Thiyagaraya nagar") == rg.norm("THIYAGARAYA_NAGAR".replace("_", " "))
    assert rg.title("CHENNAI_CENTRAL") == "Chennai Central"
    assert rg.code("20079") == 20079 and rg.code(None) is None


def test_offices_keep_every_same_named_point():
    doc = '{"features": [{"geometry": {"type": "Point", "coordinates": [80.2, 13.0]}, "properties": {"office_name": "Alandur"}},' \
          ' {"geometry": {"type": "Point", "coordinates": [78.1, 11.6]}, "properties": {"office_name": "Alandur"}}]}'
    got = rg.offices("chennai", doc)
    assert got == {"alandur": [(80.2, 13.0), (78.1, 11.6)]}
    assert rg.km((80.2, 13.0), (80.2, 13.1)) < 11.2
