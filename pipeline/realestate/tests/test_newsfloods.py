from pipeline.realestate import newsfloods


def test_rows_counts_distinct_days_per_block():
    pts = [(72.85, 19.05, "2019-07-02"), (72.85, 19.05, "2019-07-02"), (72.85, 19.05, "2024-07-08T00:00:00"), (72.85, 19.05, "")]
    r = newsfloods.rows(pts)
    assert len(r) == 1
    (row,) = r.values()
    assert row == {"flood_news_days": 2, "flood_news_recent": 1, "flood_news_last": 2024}
