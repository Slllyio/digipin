from pipeline.realestate.constituencies import clean


def test_clean_names_and_reservation():
    assert clean("NORTH WEST DELHI (SC)") == ("North West Delhi", "SC")
    assert clean("Nerela") == ("Nerela", None)
    assert clean("Mangol Puri (sc)") == ("Mangol Puri", "SC")
    assert clean(None) == (None, None)


def test_resolve_by_number_then_name():
    from pipeline.realestate.constituencies import resolve, seats
    segs = {(151, "K.R. Pura", "Karnataka"): {"pc_no": 25, "pc_name": "Bangalore North"},
            (63, "Nampally", "Telangana"): {"pc_no": 9, "pc_name": "Hyderabad"},
            (65, "Goshamahal", "Telangana"): {"pc_no": 9, "pc_name": "Hyderabad"}}
    assert resolve("151", "Krishnarajapuram", seats(segs, "Karnataka")) == (151, "K.R. Pura", 25, "Bangalore North")
    assert resolve(None, "Goshamahal (Sc)", seats(segs, "Telangana")) == (65, "Goshamahal", 9, "Hyderabad")
    assert resolve(None, "Somewhere Else", seats(segs, "Telangana")) is None
