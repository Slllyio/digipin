import json

from pipeline.traffic.compact import dumps_lines, rdp


def test_rdp_keeps_endpoints_and_drops_collinear_points():
    line = [[0, 0], [1, 0.000001], [2, 0], [3, 1]]
    assert rdp(line, 0.01) == [[0, 0], [2, 0], [3, 1]]
    assert rdp(line, 0) == line


def test_dumps_lines_rounds_drops_props_and_fits_the_budget():
    feats = [{"type": "Feature", "properties": {"osm_id": i, "highway": "primary"},
              "geometry": {"type": "LineString",
                           "coordinates": [[77.1234567 + k * 1e-4, 28.7654321 + (k % 2) * 1e-6]
                                           for k in range(50)]}} for i in range(200)]
    full = dumps_lines(feats, max_bytes=10**9)
    assert '"osm_id"' in full and "77.12346" in full
    small = dumps_lines(feats, drop_props=("osm_id",), max_bytes=len(full) // 4)
    assert len(small) <= len(full) // 4
    g = json.loads(small)["features"][0]
    assert "osm_id" not in g["properties"]
    c = g["geometry"]["coordinates"]
    assert c[0] == [77.12346, 28.76543] and len(c) < 50
