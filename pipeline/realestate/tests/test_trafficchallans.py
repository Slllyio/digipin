from pipeline.realestate import trafficchallans as tc


def test_norm_aliases():
    assert tc.norm("Cuff Pared Police Station") == tc.norm("Cuffe Parade")
    assert tc.norm("N.M.Joshi Police Station") == "nmjoshimarg"
    assert tc.norm("Andheri Police Station") == "andheri"


def test_stations_and_records():
    rows = [{"Traffic Police Station": "Andheri Police Station", "Without Helmet": "50", "Jumping signal": "10", "Wrong side driving": "5",
             "No Entry In Oneway": "5", "Causing Obstruction To Free Flow Of Traffic": "20", "Drunk and Drive": "1", "Grand Total": "100"},
            {"Traffic Police Station": "Grand Total", "Grand Total": "100"}]
    figs = tc.stations(rows)
    assert list(figs) == ["andheri"]
    assert figs["andheri"]["tc_helmet_pct"] == 50.0 and figs["andheri"]["tc_wrongway_pct"] == 10.0
    recs = list(tc.records({"a": "Andheri", "b": "Andheri", "c": "Unknown"}, figs, {"a": 600, "b": 400, "c": 10}))
    assert [r["digipin"] for r in recs] == ["a", "b"]
    assert recs[0]["tc_per_1000"] == 100.0
