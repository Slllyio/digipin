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


def test_catalog_merge_keeps_untouched_regions():
    from pipeline.cells.catalog_merge import merge
    dst = {"version": 1, "datasets": [
        {"id": "a", "title": "old", "regions": [{"name": "x"}, {"name": "y"}]},
        {"id": "b", "title": "other", "regions": [{"name": "x"}]}]}
    src = {"datasets": [{"id": "a", "title": "new", "regions": [{"name": "y", "cells": 2}]},
                        {"id": "c", "title": "skip", "regions": []}]}
    out = merge(src, dst, {"a"})
    a = next(d for d in out["datasets"] if d["id"] == "a")
    assert a["title"] == "new" and [r["name"] for r in a["regions"]] == ["x", "y"]
    assert a["regions"][1]["cells"] == 2
    assert {d["id"] for d in out["datasets"]} == {"a", "b"}


def test_walkable_tags():
    from pipeline.cells import osm_layers as o
    assert o.walkable({"highway": "residential"}) and o.walkable({"highway": "footway"})
    assert not o.walkable({"highway": "motorway"})
    assert not o.walkable({"highway": "service", "access": "private"})
    assert o.walkable({"highway": "service", "access": "private", "foot": "yes"})
    assert not o.walkable({"highway": "path", "foot": "no"})
    assert not o.walkable({"building": "yes"})


def test_walk_links_bits():
    from pipeline.cells import osm_layers as o
    d = o.CELL_DEG
    lat, lon = o.LAT0 + 1000.5 * d, o.LON0 + 2000.5 * d      # centre of cell (1000, 2000)
    # East along 3 cells, then a diagonal step north-east.
    links = o.walk_links([(lat, lon), (lat, lon + 2 * d), (lat + d, lon + 3 * d)])
    E, W, NE, SW = (o._BIT[x] for x in [(0, 1), (0, -1), (1, 1), (-1, -1)])
    assert links[(1000, 2000)] == E
    assert links[(1000, 2001)] == E | W
    assert links[(1000, 2002)] == W | NE
    assert links[(1001, 2003)] == SW
    # Masks are symmetric: every bit has its opposite on the neighbour.
    for (r, c), m in links.items():
        for i, (dr, dc) in enumerate(o.DIRS):
            if m >> i & 1:
                assert links[(r + dr, c + dc)] & o._BIT[(-dr, -dc)]
    # The lattice agrees with DIGIPIN codes: neighbours are distinct L7 cells.
    assert o.cell_of((1000, 2000)) != o.cell_of((1000, 2001))
    assert len(o.cell_of((1000, 2000))) == 7


def test_walk_dataset_rows():
    from collections import Counter
    from pipeline.cells import osm_layers as o
    code = o.cell_of(o._rc(23.25, 77.40))
    spec, table = o.walk_dataset({code: Counter({"walk_links": 0b101, "walk_m": 500})})
    assert spec.id == "osm_walk"
    assert table.columns["links"] == [5] and table.columns["degree"] == [2]
    assert table.columns["walk_km_km2"][0] > 0
