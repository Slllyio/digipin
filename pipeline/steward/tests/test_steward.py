"""End-to-end steward run over a temporary repo layout, plus scaffolding."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from pipeline.steward import checks, inventory, report, scaffold, steward
from pipeline.steward.inventory import REPO_ROOT

pytestmark = pytest.mark.unit

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)

WORKFLOW = """jobs:
  scrape:
    strategy:
      matrix:
        source: [alpha, beta]
"""
QUALITY = '''SOURCES = [
    # source              pk     stale-seconds
    ("alpha",            "id",   None),
    # NOTE: add more sources as schemas land. See scrapers/lib/quality.py
]
'''
SCHEMA = {"type": "object", "required": ["count", "records"],
          "properties": {"records": {"type": "array", "items": {"type": "object", "required": ["id"]}}}}


def _repo(tmp: Path) -> Path:
    src = tmp / "scrapers" / "sources"
    (src / "schemas").mkdir(parents=True)
    (src / "tests").mkdir()
    (tmp / ".github" / "workflows").mkdir(parents=True)
    (tmp / ".github" / "workflows" / "realtime-scrape.yml").write_text(WORKFLOW)
    (src / "tests" / "test_snapshot_quality.py").write_text(QUALITY)
    (src / "alpha.py").write_text('SOURCE_ID = "alpha"\nFEED_URL = "https://a.example"\n')
    (src / "beta.py").write_text('SOURCE_ID = "beta"\nREQUIRED_ENV = ("BETA_KEY",)\n')
    (src / "schemas" / "alpha.schema.json").write_text(json.dumps(SCHEMA))
    for sid, payload in {
        "alpha": {"generated_at_iso": "2026-10-21T11:50:00Z", "count": 2,
                  "records": [{"id": "1"}, {"id": "1"}]},          # duplicate key → contract fail
        "beta": {"generated_at_iso": "2026-10-21T11:55:00Z", "count": 0, "records": []},
    }.items():
        d = tmp / "data" / "realtime" / sid
        d.mkdir(parents=True)
        (d / "latest.json").write_text(json.dumps(payload))
    tri = tmp / "data" / "triage" / "pilot"
    tri.mkdir(parents=True)
    (tri / "latest.json").write_text(json.dumps({"generated_at": "2026-07-21T19:05:29+00:00"}))
    return tmp


def test_inventory_reads_modules_matrix_and_quality_rows(tmp_path):
    srcs = inventory.discover(_repo(tmp_path))
    assert set(srcs) == {"alpha", "beta"}
    assert srcs["alpha"].in_quality and srcs["alpha"].has_schema and srcs["alpha"].feed_url
    assert srcs["beta"].required_env == ("BETA_KEY",) and not srcs["beta"].has_schema


def test_run_flags_contract_wiring_secrets_and_stale_products(tmp_path):
    result = steward.run(_repo(tmp_path), previous={}, now=NOW)
    by = {(f["source"], f["check"]): f for f in result["findings"]}
    assert result["status"] == "fail"
    assert by[("alpha", "contract")]["severity"] == "fail"
    assert "duplicate" in by[("alpha", "contract")]["message"]
    assert by[("beta", "wiring")]["severity"] == "warn"
    assert "BETA_KEY" in by[("beta", "volume")]["hint"]
    assert by[("triage brief (pilot)", "freshness")]["severity"] == "fail"
    assert result["sources"]["alpha"]["rows"] == 2
    # Findings are ordered most severe first.
    sev = [f["severity"] for f in result["findings"]]
    assert sev == sorted(sev, key=lambda s: -{"fail": 3, "warn": 2, "info": 1}[s])


def test_drift_against_previous_profiles(tmp_path):
    result = steward.run(_repo(tmp_path), previous={"beta": {"count": 40, "null_rates": {}}}, now=NOW)
    beta_volume = [f for f in result["findings"] if f["source"] == "beta" and f["check"] == "volume"]
    assert beta_volume[0]["severity"] == "fail" and "went empty" in beta_volume[0]["message"]


def test_markdown_report(tmp_path):
    md = report.to_markdown(steward.run(_repo(tmp_path), previous={}, now=NOW))
    assert md.startswith("# Pipeline health 🔴 FAIL")
    assert "| `alpha` |" in md and "## Findings" in md


def test_matrix_and_quality_registration_are_idempotent():
    once = scaffold.add_to_matrix(WORKFLOW, "gamma")
    assert inventory.matrix_sources(once) == ["alpha", "beta", "gamma"]
    assert scaffold.add_to_matrix(once, "gamma") == once
    q = scaffold.add_quality_row(QUALITY, "gamma")
    assert inventory.quality_rows(q) == ["alpha", "gamma"]
    assert scaffold.add_quality_row(q, "gamma") == q


@pytest.mark.parametrize("fmt", scaffold.FORMATS)
def test_scaffolded_module_compiles_and_wires_up(tmp_path, fmt):
    root = _repo(tmp_path)
    touched = scaffold.scaffold("gamma_feed", "https://g.example/feed", fmt, required_env=("G_KEY",), root=root)
    module = root / "scrapers" / "sources" / "gamma_feed.py"
    assert module in touched
    compile(module.read_text(), str(module), "exec")
    srcs = inventory.discover(root)
    g = srcs["gamma_feed"]
    assert g.has_schema and g.in_matrix and g.in_quality and g.required_env == ("G_KEY",)
    with pytest.raises(FileExistsError):
        scaffold.scaffold("gamma_feed", "https://g.example/feed", fmt, root=root)


def test_scaffold_rejects_bad_input(tmp_path):
    with pytest.raises(ValueError):
        scaffold.scaffold("Bad-Id", "https://x.example", root=tmp_path)
    with pytest.raises(ValueError):
        scaffold.scaffold("good_id", "http://x.example", root=tmp_path)


def test_real_repo_inventory_is_fully_wired():
    """Every real source has a module, schema, matrix entry and quality row."""
    gaps = [f for s in inventory.discover(REPO_ROOT).values()
            for f in checks.check_wiring(s)
            if f["message"] != "no committed latest.json yet"]
    assert gaps == []
