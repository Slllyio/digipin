from pipeline.realestate import police as P


def test_utm_to_lnglat_matches_known_point():
    lng, lat = P.utm_to_lnglat(240157.669, 2176682.408)
    assert abs(lng - 78.5217) < 1e-3 and abs(lat - 19.6684) < 1e-3


def test_is_station_keeps_law_and_order_stations_only():
    keep = ["Uppal PS", "Asif Nagar PS & Quarters", "FalaknamaPS", "Kulsumpura_PS_&_Quarters", "Saroornagar WPS", "Amberpet Police Station"]
    drop = ["Nacharam PS Family Quarters", "Kushaiguda Tr.PS", "Begumpet Traffic PS", "DCP LB Nagar", "Tappachabutra_old_PS",
            "SR_Nagar_PS_New_(un_constructed)", "Police Quarter H B Colony (Bahadurpura PS)", "Outpost Kummarawadi"]
    assert all(P.is_station(n) for n in keep)
    assert not any(P.is_station(n) for n in drop)


def test_records_mark_jurisdiction_cells():
    recs = list(P.records([(72.85, 19.0)], [], ["4FK2222"]))
    assert recs == [{"digipin": "4FK2222", "in_area": 1}, {"lat": 19.0, "lng": 72.85, "stations": 1}]
