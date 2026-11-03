from pipeline.realestate.sdgcity import _num, city_rows


def test_num_drops_no_data():
    assert _num("-9999.0") is None and _num("12.5") == 12.5 and _num("") is None


def test_city_rows_picks_most_populous_and_ranks():
    centres = [
        {"oid": "1", "iso": "IND", "name": "Pune", "pop": 6e6, "space": 18.0, "space_access": 60.0, "transit": None},
        {"oid": "2", "iso": "IND", "name": "Pune", "pop": 5e3, "space": 0.5, "space_access": None, "transit": None},
        {"oid": "3", "iso": "IND", "name": "Delhi [New Delhi]", "pop": 2e7, "space": 10.0, "space_access": 50.0, "transit": 40.0},
        {"oid": "4", "iso": "FRA", "name": "Paris", "pop": 1e7, "space": 30.0, "space_access": 90.0, "transit": 95.0},
    ]
    rows = city_rows(centres)
    assert rows["pune"]["sdg_space_pct"] == 18.0
    assert rows["pune"]["sdg_space_india_pctile"] == 75 and rows["pune"]["sdg_space_world_pctile"] == 50
    assert "sdg_transit_pct" not in rows["pune"]
    assert rows["delhi"]["sdg_transit_world_pctile"] == 25
