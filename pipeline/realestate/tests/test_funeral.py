from pipeline.realestate import funeral as fu


def test_records_dedupe_and_electric():
    pts = [(80.2, 13.0, {"ASSET_NAME": "BURIAL GROUND  ( NEW CREMATORIUM - GASIFIER)"}, None),
           (80.20001, 13.00001, {"ASSET_NAME": "BURIAL GROUND"}, None),
           (77.6, 12.9, {"CrematoriumName": "Shantidhama"}, True),
           (73.8, 18.5, {"structure_": "Shastrinagar Hindu Smashanbhumi"}, None)]
    recs = list(fu.records(pts))
    assert [r["electric"] for r in recs] == [1, 1, 0]
    assert all(r["sites"] == 1 for r in recs)
