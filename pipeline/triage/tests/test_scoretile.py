"""Score-tile reader (writes a tiny fixture tile in tmp_path)."""
from __future__ import annotations

import json

import pytest

from pipeline._lib import digipin
from pipeline.triage import scoretile

pytestmark = pytest.mark.unit


def _write_tile(tmp_path):
    coverage = {
        "version": 1,
        "fields": ["population_proxy", "flood_risk"],
        "regions": [{"name": "indore_pilot", "level": 6, "shardPrefixLen": 2, "shards": ["34"]}],
    }
    (tmp_path / "coverage.json").write_text(json.dumps(coverage))
    region_dir = tmp_path / "indore_pilot"
    region_dir.mkdir()
    (region_dir / "34.json").write_text(json.dumps({"34MTML": [82, 55], "34MPLL": [0, 40]}))


def test_load_cells_decodes_and_aligns_fields(tmp_path):
    _write_tile(tmp_path)
    cells = scoretile.load_cells("indore_pilot", scores_dir=tmp_path)
    assert len(cells) == 2
    by_code = {c["code"]: c for c in cells}
    assert by_code["34MTML"]["scores"]["population_proxy"] == 82
    assert by_code["34MTML"]["scores"]["flood_risk"] == 55
    dec = digipin.decode_partial("34MTML")
    assert abs(by_code["34MTML"]["lat"] - dec["lat"]) < 1e-9


def test_region_exposure_aggregates(tmp_path):
    _write_tile(tmp_path)
    expo = scoretile.region_exposure("indore_pilot", scores_dir=tmp_path)
    assert expo["cell_count"] == 2
    assert expo["pop_max"] == 82
    assert 0 <= expo["pop_mean"] <= 82


def test_cells_near_filters_by_radius(tmp_path):
    _write_tile(tmp_path)
    dec = digipin.decode_partial("34MTML")
    near = scoretile.cells_near("indore_pilot", dec["lat"], dec["lng"], 100.0, scores_dir=tmp_path)
    assert near["cell_count"] >= 1
    far = scoretile.cells_near("indore_pilot", 0.0, 0.0, 100.0, scores_dir=tmp_path)
    assert far["cell_count"] == 0


def test_missing_tile_returns_empty(tmp_path):
    assert scoretile.load_cells("indore_pilot", scores_dir=tmp_path) == []
    assert scoretile.region_exposure("indore_pilot", scores_dir=tmp_path)["cell_count"] == 0
