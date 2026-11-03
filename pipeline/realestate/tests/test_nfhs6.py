from pipeline.realestate.nfhs6 import state_figures


def test_state_figures():
    rows = [{"Indicator": "Children under 5 years who are stunted (height-for-age) (%)", "NFHS6_Urban": "19", "NFHS6_Total": "26.5", "NFHS5_Total": "35.4"},
            {"Indicator": "Children under 5 years who are severely wasted (weight-for-height) (%)", "NFHS6_Urban": "3", "NFHS6_Total": "4", "NFHS5_Total": "8"},
            {"Indicator": "Children under 5 years who are wasted (weight-for-height) (%)", "NFHS6_Urban": "16.3", "NFHS6_Total": "18.7", "NFHS5_Total": "(19.5)"},
            {"Indicator": "Women - Blood sugar level high or very high (>140 mg/dl) or taking medicine", "NFHS6_Urban": "25.8", "NFHS6_Total": "22.3", "NFHS5_Total": "*"}]
    f = state_figures(rows)
    assert f["n6u_stunted"] == 19.0 and f["n6_stunted"] == 26.5 and f["n5_stunted"] == 35.4
    assert f["n5_wasted"] == 19.5 and "n5_sugar_women" not in f and f["n6_sugar_women"] == 22.3
