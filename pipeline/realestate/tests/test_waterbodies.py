from pipeline.realestate import waterbodies as wb


def test_records_clip_dedupe_and_flags():
    rows = [
        {"unique_id": "a", "longitude": "77.2", "latitude": "28.6", "waterbody_use_notuse": "No", "waterbody_encroached": "Yes",
         "water_body_ownership": "Panchayat", "storage_capacity_water_body_ori": "1800"},
        {"unique_id": "a", "longitude": "77.2", "latitude": "28.6"},
        {"unique_id": "b", "longitude": "77.21", "latitude": "28.61", "waterbody_use_notuse": "Yes", "waterbody_encroached": "No",
         "water_body_ownership": "Individual", "storage_capacity_water_body_ori": "0"},
        {"unique_id": "c", "longitude": "80.0", "latitude": "13.0"},
    ]
    recs = list(wb.records(rows, (76.8, 28.4, 77.4, 28.9), set()))
    assert len(recs) == 2
    assert recs[0] == {"lat": 28.6, "lng": 77.2, "bodies": 1, "not_in_use": 1, "encroached": 1, "public_pct": 100.0, "capacity_m3": 1800.0}
    assert recs[1]["not_in_use"] == 0 and recs[1]["public_pct"] == 0.0 and "capacity_m3" not in recs[1]
