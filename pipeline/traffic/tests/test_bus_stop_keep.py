import json

from pipeline.traffic import bus_stop_heat as b


def test_refresh_keeps_a_source_that_came_back_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(b, "VECTORS", tmp_path)
    old = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [77.60, 12.90]}, "properties": {"name": "", "src": "gtfs"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [77.70, 12.95]}, "properties": {"name": "", "src": "osm"}}]}
    (tmp_path / "bus_stops_x.geojson").write_text(json.dumps(old))
    monkeypatch.setattr(b, "osm", lambda r, log=print: [(77.71, 12.96, "stop", "", "osm")])
    monkeypatch.setattr(b, "gtfs", lambda r, log=print: [])
    monkeypatch.setattr(b, "overture", lambda r: [])
    gj = b.fetch("x", log=lambda *_: None)
    srcs = sorted(f["properties"]["src"] for f in gj["features"])
    assert srcs == ["gtfs", "osm"]                      # gtfs kept from disk; osm replaced by the fresh fetch
    assert [77.71, 12.96] in [f["geometry"]["coordinates"] for f in gj["features"]]
