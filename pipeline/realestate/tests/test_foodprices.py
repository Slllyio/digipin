from pipeline.realestate import foodprices as fp


def _rows(year, month, scale):
    return [{"market": "X", "pricetype": "Retail", "commodity": c, "date": f"{year}-{month:02d}-15", "price": str(10 * scale)} for c in fp.BASKET]


def test_figures():
    rows = []
    for m in range(1, 13):
        rows += _rows(2013, m, 1) + _rows(2023, m, 2)
    for y in range(2019, 2023):
        for m in range(1, 13):
            rows.append({"market": "X", "pricetype": "Retail", "commodity": "Onions", "date": f"{y}-{m:02d}-15", "price": str(10 + (m == 6) * 50)})
    f = fp.figures(fp.monthly(rows + [{"market": "Y", "pricetype": "Retail", "commodity": "Rice", "date": "2023-01-15", "price": "999"}], "X"))
    q = sum(fp.BASKET.values())
    assert f["fp_basket_rs"] == round(20 * q) and f["fp_10y_pct"] == 100 and f["fp_last_year"] == 2023
    assert f["fp_onion_swing"] == 6.0
