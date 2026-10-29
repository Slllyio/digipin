from pipeline.realestate.antyodaya import covered, match, norm, records, village


def row(name, tehsil, hh, piped, drain="2", bus="1", power="4", phc="3"):
    return {"village_name": name, "sub_district_name": tehsil, "total_hhd": str(hh), "total_hhd_having_piped_water_connection": str(piped),
            "total_hhd_with_kuccha_wall_kuccha_roof": "5", "total_hhd_not_having_sanitary_latrines": "0", "total_hhd_having_bpl_cards": "10",
            "availability_of_drainage_system": drain, "is_community_waste_disposal_system": "2", "availability_of_public_transport": bus,
            "availablility_hours_of_domestic_electricity": power, "distance_of_phc_chc": phc}


def test_norm_and_match():
    assert norm("Byrappanahalli (Part)") == norm("Birappanahalli")
    names = [(norm("Kannaiakana Agrahara"), norm("Anekal")), (norm("Sasivegatta"), norm("Bengaluru Urban")), (norm("Allehalli"), norm("Anekal"))]
    m = match([row("Kannaikana Agrahara", "Anekal", 100, 50), row("Sasvegatta", "Yelahanka", 50, 0), row("Mallenahalli", "Anekal", 80, 0),
               row("Kannaikana Agrahara", "Hoskote", 10, 0)], names)
    assert set(m) == {names[0], names[1]}               # close spelling; split tehsil; a neighbour's name and another tehsil refused
    assert len(m[names[0]]) == 1


def test_village_and_cover():
    f = village([row("A", "T", 60, 30, drain="5", bus="4"), row("A", "T", 40, 40, drain="1")])
    assert f["ma_households"] == 100 and f["ma_piped_pct"] == 70.0 and f["ma_kuccha_pct"] == 10.0
    assert f["ma_drain"] == 3.4 and f["ma_bus"] == 0 and f["ma_power_hours"] == 18 and f["ma_phc_km"] == 3.5
    assert village([row("A", "T", 5, 0)]) is None
    assert covered(f, [("X", 1), ("Y", 1)], {"X": 1000, "Y": 1000})
    assert not covered(f, [("X", 1)], {"X": 1e5})
    assert list(records({("a", "t"): [("X", "7")]}, {("a", "t"): f}))[0]["ma_village_no"] == 7
