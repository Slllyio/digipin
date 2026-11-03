from pipeline.realestate import policejuris


def test_station_name_reads_each_city_field_and_drops_ps_suffix():
    assert policejuris.station_name({"police_station_name": "V4 Rajamangalam PS"}, None) == "V4 Rajamangalam"
    assert policejuris.station_name({"PS_Name_1": "Cuffe Parade Police Station"}, None) == "Cuffe Parade"
    assert policejuris.station_name({}, "Kaggalipura P.S") == "Kaggalipura"
    assert policejuris.station_name({}, None) is None


def test_every_region_has_a_package_and_map_title():
    assert set(policejuris.PKGS) == set(policejuris.TITLES)
