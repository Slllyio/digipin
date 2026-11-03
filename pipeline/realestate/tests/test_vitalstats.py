from pipeline.realestate import vitalstats as vs


def test_years_and_figures_bbmp():
    rows = [{"Year": str(y), "BBMP Total Births": b, "BBMP Total Deaths": d, "BBMP Female Births": "470", "BBMP Male Births": "500"}
            for y, b, d in ((2017, "1000", "500"), (2018, "1000", "500"), (2019, "1000", "500"), (2020, "900", "600"), (2021, "800", "700"), (2024, "970", "480"))]
    rows.append({"Year": "2018 (30 Apr)", "BBMP Total Births": "1"})
    ys = vs.years("bengaluru", rows)
    assert sorted(ys) == [2017, 2018, 2019, 2020, 2021, 2024]
    f = vs.figures("bengaluru", ys)
    assert f["vs_year"] == 2024 and f["vs_excess_2021"] == 200 and f["vs_excess_2021_pct"] == 40.0 and f["vs_excess_2020_pct"] == 20.0
    assert f["vs_births_change_pct"] == -3.0 and f["vs_girls_per_1000"] == 940


def test_chennai_baseline_is_2019_only():
    rows = [{"Year": "2018", "Births registered": "50", "Deaths registered": "30"}, {"Year": "2019", "Births registered": "100", "Deaths registered": "60"},
            {"Year": "2021", "Births registered": "90", "Deaths registered": "90"}]
    f = vs.figures("chennai", vs.years("chennai", rows))
    assert f["vs_deaths_base"] == 60 and f["vs_excess_2021_pct"] == 50.0 and "vs_girls_per_1000" not in f
