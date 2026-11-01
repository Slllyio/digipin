from pipeline.realestate.waterbalance import summarise


def test_summarise_base_and_now():
    m = []
    for y in list(range(1961, 1991)) + list(range(2015, 2025)):
        old = y < 2000
        for mo in range(1, 13):
            m.append((y, mo, {"pet": 1000 if old else 900, "def": 500, "pr": 60 if old else 70, "vpd": 300 if mo in (3, 4, 5) else 100}))
    f = summarise(m)
    assert f["ta_pet_base"] == 1200 and f["ta_pet_now"] == 1080
    assert f["ta_pr_base"] == 720 and f["ta_pr_now"] == 840
    assert f["ta_def_base"] == 600 and f["ta_vpd_now"] == 3.0


def test_summarise_skips_partial_years():
    assert summarise([(1961, 1, {"pet": 1, "def": 1, "pr": 1, "vpd": 1})]) == {}
