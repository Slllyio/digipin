from pipeline.realestate import streetdogs as sd


def test_ward_keys():
    assert sd.ward_keys("FN") == ("F/N",) and sd.ward_keys("RC*") == ("R/C",)
    assert sd.ward_keys("RN and RC") == ("R/N", "R/C") and sd.ward_keys("Ward A") == ("A",)
    assert sd.ward_keys("Street Total") == () and sd.ward_keys("Total (4 wards)") == ()


def test_wards_joins_three_tables():
    ws = sd.wards(
        [{"Ward_or_Track_ID": "PN", "Dogs_counted_per_km": "17.61", "Total_roaming_dogs": "5847"}, {"Ward_or_Track_ID": "Total", "Dogs_counted_per_km": ""}],
        [{"Ward_Number": "RN and RC", "Percent_Total_Sterilized": "73.1"}],
        [{"Ward": "PN", "Dogs_per_km_2014": "22.4", "Percent_Change": "-21.6"}, {"Ward": "Total (19 wards)", "Percent_Change": "-31.6"}])
    assert ws["P/N"] == {"sd_ward_no": 18, "sd_per_km": 17.61, "sd_roaming": 5847.0, "sd_per_km_2014": 22.4, "sd_change_pct": -21.6}
    assert ws["R/N"]["sd_sterilised_pct"] == ws["R/C"]["sd_sterilised_pct"] == 73.1
    assert "A" not in ws
    assert list(sd.records([("x", "P/N"), ("y", "A")], ws))[0]["digipin"] == "x"
