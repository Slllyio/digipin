from pipeline.realestate import btpcrashes as b


def test_key_maps_spellings_and_new_stations():
    assert b.key("Halasooru") == b.key("Ulsoor") == b.key("Halasur PS") == "halasur"
    assert b.key("K.Swamy Lyt.") == b.key("K S Layout") == "kumaraswamylayout"
    assert b.key("Thalagattapura") == "kumaraswamylayout"          # carved from K S Layout after 2022
    assert b.key("Indiranagar") == b.key("Jeevan Bheemanagar Traffic PS")


def test_parse_and_per_station_roll_up():
    old = "Zone,Station,2018 - Fatal,2018 - Killed,2018 - Total Cases,2019 - Fatal,2019 - Total Cases\nEast,K S Layout,10,11,50,10,40\nEast,Total,10,11,50,10,40\n"
    new = "﻿Zone,Sub-division,Station,2025-Non Fatal,2025-Fatal crashes,2025-Total crashes\nS,S,K S Layout,30,10,40\nS,S,Thalagattapura,10,5,15\n"
    t = {**b.parse_table(old), **b.parse_table(new.lstrip("﻿"))}
    assert t[(2025, "fatal")] == {"kumaraswamylayout": 15}
    assert t[(2018, "total")] == {"kumaraswamylayout": 50}         # the Total row is skipped
    s = b.per_station(t)["kumaraswamylayout"]
    assert s == {"crashes_yr": 55.0, "fatal_yr": 15.0, "fatal_change_pct": 50}
