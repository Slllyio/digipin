from pipeline.realestate import police


def test_station_name_reads_each_map():
    assert police.station_name({}, "Cuffe Parade Police Station") == "Cuffe Parade"
    assert police.station_name({"PS_BOUNDName": "Kaggalipura PS"}, "x") == "Kaggalipura"
    assert police.station_name({"PS_Name_1": " Bahadurpura "}, None) == "Bahadurpura"
    assert police.station_name({}, "") is None
