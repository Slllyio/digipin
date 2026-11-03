from pipeline.realestate.cityemissions import figures, total


def _row():
    r = {"GC_POP_TOT_2025": 1_000_000}
    for y, ind, res, tr in ((2000, 400, 600, 0), (2024, 1500, 500, 0)):
        r[f"EMI_PM2.5_Industry_{y}"], r[f"EMI_PM2.5_Residential_{y}"], r[f"EMI_PM2.5_Transport_{y}"] = ind, res, tr
        r[f"EMI_NOx_Transport_{y}"] = 1000 if y == 2000 else 1500
    r["EMI_CO2_Industry_2024"] = 9e9     # never read
    return r


def test_total_ignores_missing_sectors():
    assert total(_row(), "PM2.5", 2024) == 2000
    assert total(_row(), "NOx", 2000) == 1000


def test_figures():
    f = figures(_row(), india_median_kg=1.0)
    assert f["ce_pm25_t"] == 2000 and f["ce_pm25_2000_pct"] == 100
    assert f["ce_pm25_kg_pp"] == 2.0 and f["ce_pm25_vs_india"] == 2.0
    assert f["ce_homes_2000_pct"] == 60 and f["ce_homes_pct"] == 25 and f["ce_industry_pct"] == 75
    assert f["ce_nox_2000_pct"] == 50
    assert not any(k.startswith("ce_co2") for k in f)
