from pipeline.realestate.roaddeaths import figures


def test_figures():
    cities = {"Pune": {"2024 Killed": "345", "2023 Killed": "350", "2024 Accidents": "1,400", "2024 Ranking Killed": "20", "2024 Injured": "900"},
              "Agra": {"2024 Killed": "586", "2024 Accidents": "1,223"}, "Total": {"2024 Killed": "9"}}
    modes = {"Pune": {"Sl No": "1", "City": "Pune", "Pedestrians": "100", "Two-Wheelers": "200", "Others": "50", "Other NMT (incl e-rickshaws)": "50"}}
    viols = {"Pune": {"Over-speeding": "300", "Total": "345"}}
    f = figures(cities, modes, viols)
    assert set(f) == {"Pune", "Agra"}
    p = f["Pune"]
    assert p["rd_per100"] == 24.6 and p["rd_pedestrian_pct"] == 25.0 and p["rd_other_pct"] == 25.0 and p["rd_speeding_pct"] == 87.0
    assert p["rd_per100_median"] == round((24.6 + 47.9) / 2, 1)
