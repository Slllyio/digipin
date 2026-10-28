from pipeline.realestate import villages


def pm(name, tehsil="HAVELI"):
    return (f'<Placemark><ExtendedData><SchemaData><SimpleData name="VILLAGE">{name}</SimpleData>'
            f'<SimpleData name="TEHSIL">{tehsil}</SimpleData><SimpleData name="DISTRICT">PUNE</SimpleData></SchemaData></ExtendedData>'
            '<Polygon><outerBoundaryIs><LinearRing><coordinates>73.9,18.5 73.91,18.5 73.91,18.51 73.9,18.51 73.9,18.5</coordinates>'
            '</LinearRing></outerBoundaryIs></Polygon></Placemark>')


def test_villages_titles_names_and_flags_town_limits():
    got = villages.villages("<kml><Document>" + pm("WAGHOLI") + pm("Urban") + pm("Hadapsar (Urban)") + pm("Jadid Chhawni") + "</Document></kml>")
    assert [(v[0], v[1], v[2], v[6]) for v in got] == [
        ("Wagholi", "Haveli", "Pune", False), ("Urban", "Haveli", "Pune", True),
        ("Hadapsar (Urban)", "Haveli", "Pune", True), ("Jadid Chhawni", "Haveli", "Pune", True)]
    assert 1.1 < got[0][4] < 1.3


def test_town_regex_keeps_ordinary_villages():
    for name in ("Bhosri", "Kathwada", "Basai Darapur", "Amruthahalli"):
        assert not villages.TOWN.search(name)
    for name in ("Bruhut B. M.p Corporation Limit", "Yelahanka Muncipality", "Dhandhuka (M)", "Suburbs Of Kolkata", "Bangalore"):
        assert villages.TOWN.search(name)
