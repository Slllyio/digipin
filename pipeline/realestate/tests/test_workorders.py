from pipeline.realestate.workorders import constituencies, records


def test_constituencies():
    rows = [{"AC Num": "173", "Grand Total": "2,00,00,00,000", "Roads and Infrastructure": "50,00,00,000", "Roads and Drains": "50,00,00,000", "Drainage": "1,00,00,000"},
            {"AC Num": "Uncategorized", "Grand Total": "9"}]
    acs = constituencies(rows)
    assert list(acs) == [173]
    assert acs[173]["wo_total_cr"] == 200.0 and acs[173]["wo_roads_cr"] == 100.0 and acs[173]["wo_drains_cr"] == 1.0
    assert acs[173]["wo_lights_cr"] == 0.0
    recs = list(records([("X", 173), ("Y", 150)], acs))
    assert len(recs) == 1 and recs[0]["wo_ac"] == 173
