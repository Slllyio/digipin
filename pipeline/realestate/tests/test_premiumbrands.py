from pipeline.realestate.premiumbrands import kind_of, rows_from


def test_kind_of():
    assert kind_of("Starbucks") == "premium" and kind_of("NEXA") == "premium" and kind_of("Taj Hotels") == "premium"
    assert kind_of("Domino's") == "everyday" and kind_of("Punjab National Bank") == "everyday"
    assert kind_of("Sharma Sweets") is None and kind_of(None) is None


def test_rows_from_share_needs_three():
    rows = rows_from([(28.6, 77.2, "Starbucks"), (28.6, 77.2, "KFC"), (28.6, 77.2, "Zara"), (19.1, 72.9, "KFC")])
    a, b = sorted(rows.values(), key=lambda r: -r["pb_premium"])
    assert a == {"pb_premium": 2, "pb_everyday": 1, "pb_premium_share": 66.7}
    assert "pb_premium_share" not in b
