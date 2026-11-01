from pipeline.realestate.gatedstreets import rows_from


def test_rows_from_private_and_oneway_shares():
    segs = [(28.6, 77.2, "residential", 300.0, True, False), (28.6, 77.2, "service", 100.0, False, False),
            (28.6, 77.2, "primary", 400.0, False, True), (28.6, 77.2, "footway", 999.0, True, False)]
    (r,) = rows_from(segs).values()
    assert r["gs_local_km"] == 0.4 and r["gs_private_km"] == 0.3
    assert r["gs_private_pct"] == 75.0 and r["gs_oneway_pct"] == 50.0


def test_rows_from_needs_enough_local_street():
    (r,) = rows_from([(28.6, 77.2, "residential", 100.0, True, False)]).values()
    assert "gs_private_pct" not in r
