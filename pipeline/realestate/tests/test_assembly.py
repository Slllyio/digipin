from pipeline.realestate import assembly as a


def test_parse_and_seat_result():
    rows = [{"AC No": "1", "AC Name": "NERELA", "Party": "Bharatiya Janata Party", "Total Votes": "600"},
            {"AC No": "1", "AC Name": "NERELA", "Party": "Aam Aadmi Party", "Total Votes": "300"},
            {"AC No": "1", "AC Name": "NERELA", "Party": "None of the Above", "Total Votes": "100"}]
    r = a.seat_result(a.parse_eci(rows)[1])
    assert r == {"mla_party": "Bharatiya Janata Party", "mla_share_pct": 60.0, "mla_runner_up": "Aam Aadmi Party", "mla_margin_pct": 30.0}


def test_party_codes_and_tg_rows():
    assert a.party("BHRS") == "Bharat Rashtra Samithi" and a.party_id("BHRS") == a.party_id("Bharat Rashtra Samithi") > 0
    assert a.party_id("Shiv Sena (Uddhav Balasaheb Thackrey)") == a.party_id("Shiv Sena (Uddhav Balasaheb Thackeray)")
    assert a.party_id("Some New Party") == 0
    tg = [("Telangana", 1, "Sirpur", "X", "M", 40, "GEN", "BJP", "s", 0, 0, 500, 0, 9000),
          ("TURN OUT", None, None, None, None, None, "TOTAL:", None, None, 1, 1, 2, 80, None)]
    assert a.parse_tg(tg)[1]["cands"] == [("Bharatiya Janata Party", 500.0)]


def test_block_rows_need_matching_names():
    res = {5: {"name": "JANGPURA", "cands": [("Bharatiya Janata Party", 51), ("Aam Aadmi Party", 49)], "nota": 0}}
    seat_of = {"a": (5, "Jangpura"), "b": (5, "Sohna"), "c": (5, None)}
    rows = a.block_rows(seat_of, res, 2025, {"a": "Aam Aadmi Party"})
    assert set(rows) == {"a"} and rows["a"]["mla_margin_pct"] == 2.0 and rows["a"]["mp_party_id"] == a.party_id("Aam Aadmi Party")
    assert set(a.block_rows(seat_of, res, 2025, by_number=True)) == {"a", "c"}
