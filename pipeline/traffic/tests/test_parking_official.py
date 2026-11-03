import json

from pipeline.traffic import parking


def test_official_spaces_sum_per_block(tmp_path, monkeypatch):
    monkeypatch.setattr(parking, "VECTORS", tmp_path)
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [72.8300, 19.0000]}, "properties": {"spaces": 100}},
             {"type": "Feature", "geometry": {"type": "Point", "coordinates": [72.8301, 19.0001]}, "properties": {"spaces": 50}}]
    (tmp_path / "parking_lots_official_x.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    got = parking.official_spaces("x")
    assert sum(got.values()) == 150 and len(got) == 1
    assert parking.official_spaces("none") == {}
