from pipeline.realestate.census2011 import admin_wards, hh14, pca, records, wards


def hh_row(ward, room=30.0, lat=40.0, car=10.0):
    r = [None] * 148
    r[7], r[9] = ward, "Urban"
    for k in range(10, 148):
        r[k] = 1.0
    r[48], r[49], r[99], r[136] = 5.0, room - 5.0, lat, car
    return tuple(r)


def test_join():
    names = admin_wards([{"Ward Code": "101", "Ward Name": "A"}, {"Ward Code": "102", "Ward Name": "A"}, {"Ward Code": "203", "Ward Name": "B"}])
    counts = pca([{"Ward": w, "Level": "WARD", "TRU": "Total", "No_HH": hh, "TOT_P": 4 * hh, "TOT_F": 2 * hh, "P_06": 0, "P_LIT": 3 * hh, "TOT_WORK_F": hh // 5}
                  for w, hh in (("0101", 100), ("0102", 300), ("0203", 50))] + [{"Ward": "0000", "Level": "TOWN", "TRU": "Total"}])
    shares = hh14([hh_row("0101", room=20), hh_row("0102", room=60), hh_row("0203"), hh_row("0000")])
    ws = wards(names, counts, shares)
    assert set(ws) == {"A", "B"}
    assert ws["A"]["c11_households"] == 400 and ws["A"]["c11_hh_size"] == 4.0
    assert ws["A"]["c11_one_room_pct"] == 50.0          # (20*100 + 60*300) / 400
    assert ws["A"]["c11_literacy_pct"] == 75.0 and ws["A"]["c11_women_work_pct"] == 10.0
    recs = list(records([("X", "A"), ("Y", "Z")], ws))
    assert len(recs) == 1 and recs[0]["c11_ward_no"] == 1 and recs[0]["c11_ward"] == "A"
