"""Offline tests for the open-data layer builders (Earth Engine grid maths, OSM scan)."""
import json

import pytest

from pipeline._lib import digipin
from pipeline.cells import earthengine as gee
from pipeline.cells import store


def test_aligned_bbox_snaps_to_cell_edges():
    lat_step, lon_step = gee.cell_step(7)
    w, s, e, n = gee.aligned_bbox((77.30, 23.18, 77.52, 23.32), 7)
    assert w <= 77.30 and s <= 23.18 and e >= 77.52 and n >= 23.32
    for v, origin, step in ((w, 63.5, lon_step), (s, 2.5, lat_step), (e, 63.5, lon_step)):
        k = (v - origin) / step
        assert abs(k - round(k)) < 1e-6
    # A pixel centre on that grid falls in exactly one cell, whose bounds contain it.
    lat, lng = n - lat_step / 2, w + lon_step / 2
    b = digipin.decode_partial(digipin.encode(lat, lng).replace("-", "")[:7])["bounds"]
    assert b["south"] <= lat <= b["north"] and b["west"] <= lng <= b["east"]
    assert abs((b["north"] - b["south"]) - lat_step) < 1e-9


def test_cell_area_matches_level_size():
    code = digipin.encode(23.25, 77.41).replace("-", "")
    a7 = gee.cell_area_km2(code[:7])
    assert 0.05 < a7 < 0.07                       # ~244 m square
    assert abs(gee.cell_area_km2(code[:6]) / a7 - 16) < 0.01


def test_merge_and_round():
    assert gee.merge({"A": {"x": 1}}, {"A": {"y": 2}, "B": {"x": 3}}) == {"A": {"x": 1, "y": 2},
                                                                          "B": {"x": 3}}
    assert gee.r(None) is None and gee.r(1.26) == 1.3


_OSM = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6" generator="test">
  <node id="1" lat="23.2500" lon="77.4000" version="1"/>
  <node id="2" lat="23.2500" lon="77.4010" version="1"/>
  <node id="3" lat="23.2510" lon="77.4010" version="1"/>
  <node id="4" lat="23.2510" lon="77.4000" version="1"/>
  <node id="5" lat="23.2505" lon="77.4005" version="1">
    <tag k="amenity" v="hospital"/><tag k="name" v="H"/>
  </node>
  <node id="6" lat="23.2506" lon="77.4006" version="1"><tag k="amenity" v="restaurant"/></node>
  <node id="7" lat="23.2500" lon="77.4020" version="1"/>
  <way id="10" version="1">
    <nd ref="1"/><nd ref="2"/><nd ref="7"/><tag k="highway" v="primary"/>
  </way>
  <way id="11" version="1">
    <nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/>
  </way>
  <way id="12" version="1">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
    <tag k="building" v="yes"/>
  </way>
</osm>
"""


@pytest.fixture
def osm_file(tmp_path):
    pytest.importorskip("osmium")
    p = tmp_path / "t.osm"
    p.write_text(_OSM)
    return p


def test_osm_scan_counts(osm_file):
    from pipeline.cells import osm_layers
    cells = osm_layers.scan(str(osm_file))
    tot = sum((c for c in cells.values()), start=__import__("collections").Counter())
    assert tot["cat:healthcare"] == 1 and tot["cat:food"] == 1 and tot["poi"] == 2
    # 0.002° of longitude at 23.25°N ≈ 204.6 m of primary; 0.001° lat ≈ 111 m residential.
    assert tot["road_major_m"] == pytest.approx(204.6, abs=1.5)
    assert tot["road_local_m"] == pytest.approx(111.3, abs=1.0)
    assert tot["junctions"] == 1                        # node 2 is on both roads
    assert tot["buildings"] == 1
    assert tot["bldg_m2"] == pytest.approx(102.3 * 111.3, rel=0.02)


def test_osm_datasets_write(osm_file, tmp_path):
    from pipeline.cells import osm_layers
    cells = osm_layers.scan(str(osm_file))
    out = tmp_path / "cells"
    for spec, table in (osm_layers.amenity_dataset(cells), osm_layers.roads_dataset(cells)):
        store.write_dataset(out, spec, "bhopal", table, parquet=False)
    cat = json.loads((out / "catalog.json").read_text())
    assert {d["id"] for d in cat["datasets"]} == {"osm_amenities", "osm_roads"}
    roads = store.read_json(out / "osm_roads" / "bhopal.json")
    assert max(roads.columns["road_km_km2"]) > 0
    assert all(0 <= v <= 100 for v in roads.columns["building_cover_pct"])
