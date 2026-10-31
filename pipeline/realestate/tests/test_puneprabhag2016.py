from pipeline.realestate import puneprabhag2016 as pp


def test_prabhag_rows():
    foot = [{"Prabhag_no": "1", "length_of_roads": "100", "length_of_roads_with_footpath_on_both_sides": "20",
             "length_of_roads_with_footpath_on_one_side": "10", "Percentage_of_roads_with_usable_footpaths": "19.4"}]
    swd = [{"Prabhag_no": "1", "Percentage_of_roads_with_storm_water_drainage": "18.02"}, {"Prabhag_no": "2", "Percentage_of_roads_with_storm_water_drainage": "x"}]
    slum = [{"Prabhag_no": "1", "slum_hh": "800"}]
    rows = pp.prabhag_rows(foot, swd, slum)
    assert rows[1] == {"pp_prabhag": 1, "pp_footpath_pct": 19.4, "pp_road_km": 100.0, "pp_footpath_ratio": 0.3, "pp_swd_pct": 18.02, "pp_slum_hh": 800}
    assert rows[2] == {"pp_prabhag": 2}
