"""End-to-end test for the tile builder + smoke check (A4).

Runs build over indore_pilot at level 5 (fast, ~120 cells) using a tiny .osm
fixture, then asserts the shard/coverage layout and that smoke_check gates it.
"""
from __future__ import annotations

import json

import pytest

from pipeline._lib import digipin, grid, regions
from pipeline.scores import build_tile, score_grid, smoke_check

# Place POIs at the *centre* of the level-5 cell covering Indore CBD, so the
# 400 m disc kernel counts them at level 5 (cell spacing ~975 m would otherwise
# leave corner POIs >400 m from every cell centre — a coarse-level gap that
# doesn't occur at the intended levels 6/7).
_CODE5 = digipin.encode(22.70, 75.80).replace("-", "")[:5]
_CENTER = digipin.decode_partial(_CODE5)
_LAT, _LON = _CENTER["lat"], _CENTER["lng"]


@pytest.fixture
def fixture_osm(tmp_path):
    nodes = "\n".join(
        f'<node id="{i}" lat="{_LAT}" lon="{_LON}"><tag k="amenity" v="restaurant"/></node>'
        for i in range(1, 9)
    ) + f'\n<node id="20" lat="{_LAT}" lon="{_LON}"><tag k="leisure" v="park"/></node>'
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<osm version="0.6" generator="test">\n' + nodes + "\n</osm>\n")
    p = tmp_path / "tiny.osm"
    p.write_text(xml)
    return str(p)


def test_build_writes_shards_and_coverage(tmp_path, fixture_osm):
    out = tmp_path / "scores"
    summary = build_tile.build("indore_pilot", level=5, out_dir=str(out), pbf=fixture_osm)

    expected = grid.count_cells_for_bbox(build_tile._bbox_dict(regions.INDORE_PILOT), 5)
    assert summary["cells"] == expected

    cov = json.loads((out / "coverage.json").read_text())
    assert cov["fields"] == score_grid.score_field_names()
    assert cov["radiusM"] == build_tile.DEFAULT_RADIUS_M
    entry = next(r for r in cov["regions"] if r["name"] == "indore_pilot")
    assert entry["level"] == 5
    assert entry["path"] == "data/scores/indore_pilot/"

    shard_files = list((out / "indore_pilot").glob("*.json"))
    assert shard_files
    # shard values are flat arrays of len(fields)
    any_shard = json.loads(shard_files[0].read_text())
    code, values = next(iter(any_shard.items()))
    assert len(values) == len(cov["fields"])
    assert "-" not in code  # dashless keys


def test_smoke_check_passes_on_a_real_build(tmp_path, fixture_osm):
    out = tmp_path / "scores"
    build_tile.build("indore_pilot", level=5, out_dir=str(out), pbf=fixture_osm)
    summary = smoke_check.check(out, region="indore_pilot")
    assert summary["distinct"] >= 2  # POI cells differ from empty ones


def test_smoke_check_rejects_degenerate_grid(tmp_path):
    # No pbf/rasters -> every cell scores identically -> must be rejected.
    out = tmp_path / "scores"
    build_tile.build("indore_pilot", level=5, out_dir=str(out))
    with pytest.raises(smoke_check.SmokeFailure, match="degenerate"):
        smoke_check.check(out, region="indore_pilot")


def test_smoke_check_landmark_assertion(tmp_path, fixture_osm):
    out = tmp_path / "scores"
    build_tile.build("indore_pilot", level=5, out_dir=str(out), pbf=fixture_osm)
    # The cell covering our POIs must show food-driven walkability.
    landmark = {"code": _CODE5, "field": "walkability", "min": 1}
    summary = smoke_check.check(out, region="indore_pilot", landmark=landmark)
    assert summary["cells"] > 0


def test_unknown_region_raises(tmp_path):
    with pytest.raises(ValueError, match="unknown region"):
        build_tile.build("atlantis", level=5, out_dir=str(tmp_path))
