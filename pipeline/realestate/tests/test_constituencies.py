from pipeline.realestate.constituencies import clean


def test_clean_names_and_reservation():
    assert clean("NORTH WEST DELHI (SC)") == ("North West Delhi", "SC")
    assert clean("Nerela") == ("Nerela", None)
    assert clean("Mangol Puri (sc)") == ("Mangol Puri", "SC")
    assert clean(None) == (None, None)
