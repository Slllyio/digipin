from pipeline.realestate import wellquality as w


def test_wells_reads_both_layouts_and_skips_missing_coordinates():
    rows = [{"Fe mg/L ": "0.02", "Flouride (mg/L)": "0.26", "NO3 (mg/L)": "50", "TH (as CaCO3) mg/L": "608", "Latitude": "12.7", "Longitude": "77.6", "Village": "X"},
            {"NO3 (mg/L)": "85", "Latitude": "", "Longitude": "77.6"}]
    assert w.wells(rows) == [{"lat": 12.7, "lng": 77.6, "no3": 50.0, "f": 0.26, "fe": 0.02, "th": 608.0}]


def test_block_rows_counts_wells_over_limit_and_same_site_history():
    now = [{"lat": 12.90, "lng": 77.60, "no3": 88}, {"lat": 12.92, "lng": 77.60, "no3": 20}, {"lat": 13.20, "lng": 77.60, "no3": 60}]
    prev = [{"lat": 12.901, "lng": 77.60, "no3": 50}]
    r = w.block_rows([("a", 12.90, 77.60)], now, prev)["a"]
    assert r["wq_no3"] == 88 and r["wq_no3_prev"] == 50 and r["wq_wells_5km"] == 2 and r["wq_over_5km"] == 1
