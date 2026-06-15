"""Unit tests for the OSM feature counter (A2), against a tiny .osm fixture.

pyosmium reads .osm XML directly, so the fixture is hand-written XML — no binary
.pbf needed. Verifies: classification through the bin pass, the 400 m disc
kernel (in vs out), way bbox-centre representative point, and worship subtypes.
"""
from __future__ import annotations

import math

import pytest

from pipeline.scores import count_features
from pipeline.scores.composite import compute_scores

# A POI ~400 m east of (lat, lon): dlon = 400 / (111320*cos(lat)).
_LAT, _LON = 22.7000, 75.8000


def _dlon(metres, lat=_LAT):
    return metres / (111_320.0 * math.cos(math.radians(lat)))


def _osm(nodes_xml, ways_xml=""):
    # The XML declaration must sit at byte 0 — no leading whitespace.
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<osm version="0.6" generator="test">\n'
        + nodes_xml + "\n" + ways_xml + "\n</osm>\n"
    )


@pytest.fixture
def fixture_pbf(tmp_path):
    # restaurant + two worship (hindu, muslim) at the centre; one restaurant
    # ~300 m east (inside 400 m); one restaurant ~600 m east (outside);
    # a building way whose node-bbox centre sits at the centre.
    near = _LON + _dlon(300)
    far = _LON + _dlon(600)
    nodes = f"""
      <node id="1" lat="{_LAT}" lon="{_LON}"><tag k="amenity" v="restaurant"/></node>
      <node id="2" lat="{_LAT}" lon="{_LON}"><tag k="amenity" v="place_of_worship"/><tag k="religion" v="Hindu"/></node>
      <node id="3" lat="{_LAT}" lon="{_LON}"><tag k="amenity" v="place_of_worship"/><tag k="religion" v="muslim"/></node>
      <node id="4" lat="{_LAT}" lon="{near}"><tag k="amenity" v="restaurant"/></node>
      <node id="5" lat="{_LAT}" lon="{far}"><tag k="amenity" v="restaurant"/></node>
      <node id="10" lat="{_LAT - 0.0001}" lon="{_LON - 0.0001}"/>
      <node id="11" lat="{_LAT + 0.0001}" lon="{_LON + 0.0001}"/>
    """
    ways = """
      <way id="100"><nd ref="10"/><nd ref="11"/><tag k="building" v="house"/></way>
    """
    p = tmp_path / "tiny.osm"
    p.write_text(_osm(nodes, ways))
    return str(p)


def _cell(lat, lng):
    return {"code": "TEST", "center": {"lat": lat, "lng": lng},
            "bounds": {"south": lat, "north": lat, "west": lng, "east": lng}}


def test_bins_classify_and_count(fixture_pbf):
    bins = count_features.build_bins(fixture_pbf)
    # 3 restaurants + 2 worship + 1 building house (= buildings_total + res_buildings)
    assert bins.n_elements == 6


def test_kernel_counts_within_radius_only(fixture_pbf):
    bins = count_features.build_bins(fixture_pbf)
    counter = count_features.make_feature_counter(bins, radius_m=400.0)
    data = counter(_cell(_LAT, _LON))
    feats = data["categories"]
    # centre restaurant + the 300 m one are in; the 600 m one is out -> 2
    assert feats["food"]["features"]["restaurants"]["count"] == 2
    # building house -> buildings_total and res_buildings both
    assert feats["landuse"]["features"]["buildings_total"]["count"] == 1
    assert feats["landuse"]["features"]["res_buildings"]["count"] == 1
    # worship count + lowercased subtypes
    worship = feats["entertainment"]["features"]["worship"]
    assert worship["count"] == 2
    assert worship["subTypes"] == {"hindu": 1, "muslim": 1}


def test_far_cell_counts_nothing(fixture_pbf):
    bins = count_features.build_bins(fixture_pbf)
    counter = count_features.make_feature_counter(bins, radius_m=400.0)
    data = counter(_cell(_LAT + 0.05, _LON + 0.05))  # ~5-7 km away
    assert data["categories"]["food"]["features"]["restaurants"]["count"] == 0


def test_counter_output_feeds_compute_scores(fixture_pbf):
    bins = count_features.build_bins(fixture_pbf)
    counter = count_features.make_feature_counter(bins, radius_m=400.0)
    scores = compute_scores(counter(_cell(_LAT, _LON)))
    assert 0 <= scores["walkability"]["value"] <= 100
    assert scores["food_diversity"]["value"] > 0  # restaurants present


def test_env_sampler_is_merged(fixture_pbf):
    bins = count_features.build_bins(fixture_pbf)
    sampler = lambda cell: {"populationDensity": {"personsPerHectare": 150}}  # noqa: E731
    counter = count_features.make_feature_counter(bins, radius_m=400.0, env_sampler=sampler)
    data = counter(_cell(_LAT, _LON))
    assert data["environment"]["populationDensity"]["personsPerHectare"] == 150


# ── Multipolygon relations (Phase 1 #4) ──────────────────────────────────────

def _square_nodes(base_id, lat, lon, d=0.0005):
    return (
        f'<node id="{base_id}" lat="{lat - d}" lon="{lon - d}"/>'
        f'<node id="{base_id + 1}" lat="{lat - d}" lon="{lon + d}"/>'
        f'<node id="{base_id + 2}" lat="{lat + d}" lon="{lon + d}"/>'
        f'<node id="{base_id + 3}" lat="{lat + d}" lon="{lon - d}"/>'
    )


def _park_relation_osm(tmp_path):
    # A park mapped as a MULTIPOLYGON RELATION (untagged outer way + tagged
    # relation) centred on (_LAT, _LON) — the v1 gap this fixture exercises.
    nodes = _square_nodes(20, _LAT, _LON)
    ways = '<way id="200"><nd ref="20"/><nd ref="21"/><nd ref="22"/><nd ref="23"/><nd ref="20"/></way>'
    rels = ('<relation id="300">'
            '<member type="way" ref="200" role="outer"/>'
            '<tag k="type" v="multipolygon"/><tag k="leisure" v="park"/>'
            '</relation>')
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="test">\n'
           + nodes + ways + rels + '\n</osm>\n')
    p = tmp_path / "park_rel.osm"
    p.write_text(xml)
    return str(p)


def test_multipolygon_relation_is_counted(tmp_path):
    bins = count_features.build_bins(_park_relation_osm(tmp_path))
    counter = count_features.make_feature_counter(bins, radius_m=400.0)
    parks = counter(_cell(_LAT, _LON))["categories"]["leisure"]["features"]["parks"]
    assert parks["count"] == 1, "multipolygon-relation park should be counted once"


def test_closed_way_park_is_not_double_counted(tmp_path):
    # Same park, but mapped as a TAGGED CLOSED WAY. The area handler also yields
    # it as a from_way area; that must be skipped so it counts once, not twice.
    nodes = _square_nodes(20, _LAT, _LON)
    ways = ('<way id="200"><nd ref="20"/><nd ref="21"/><nd ref="22"/><nd ref="23"/><nd ref="20"/>'
            '<tag k="leisure" v="park"/></way>')
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="test">\n'
           + nodes + ways + '\n</osm>\n')
    p = tmp_path / "park_way.osm"
    p.write_text(xml)
    bins = count_features.build_bins(str(p))
    counter = count_features.make_feature_counter(bins, radius_m=400.0)
    parks = counter(_cell(_LAT, _LON))["categories"]["leisure"]["features"]["parks"]
    assert parks["count"] == 1, "closed-way park must not be double-counted via its area"
