import pytest

from pipeline.realestate import slums


def test_notified_reads_every_spelling():
    assert slums.notified({"NOTIFIED_N": "Notified"}) is True
    assert slums.notified({"Slum_Type": "Notofied"}) is True
    for v in ("Non-Notified", "Non_Notofied", "Non Notified", "Non-Notified "):
        assert slums.notified({"Slum_Type": v}) is False
    assert slums.notified({"NOTIFIED_N": ""}) is None
    assert slums.notified({}) is None


def test_overlay_area_share():
    pytest.importorskip("duckdb")
    sq = lambda w, s, e, n: {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}
    feats = [{"geometry": sq(0, 0, 0.5, 1), "properties": {"Slum_Type": "Notified"}},
             {"geometry": sq(0.5, 0, 0.75, 1), "properties": {"Slum_Type": "Non-Notified"}}]
    out = slums.overlay(feats, [("A", 0, 0, 1, 1), ("B", 5, 5, 6, 6)])
    assert list(out) == ["A"]
    assert out["A"] == {"slum_pct": 75.0, "slums": 2, "notified_pct": 67}
