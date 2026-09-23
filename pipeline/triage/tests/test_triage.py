"""Ranking + brief assembly (score tile stubbed via monkeypatch)."""
from __future__ import annotations

import pytest

from pipeline.triage import brief, scoretile, triage
from pipeline.triage.model import HazardEvent

pytestmark = pytest.mark.unit


def _ev(**kw):
    base = dict(source="ndma_sachet", event_id="1", hazard="storm", severity=0.5, headline="over Indore")
    base.update(kw)
    return HazardEvent(**base)


@pytest.fixture
def stub_tile(monkeypatch):
    """No real tile I/O: fixed region exposure, empty cells."""
    monkeypatch.setattr(scoretile, "load_cells", lambda *a, **k: [])
    monkeypatch.setattr(scoretile, "region_exposure",
                        lambda *a, **k: {"pop_p90": 80, "flood_p90": 10, "cell_count": 5, "pop_mean": 40, "flood_mean": 5})


def test_priority_orders_severe_flood_above_minor_storm(stub_tile):
    events = [
        _ev(event_id="minor", hazard="storm", severity=0.25),
        _ev(event_id="severe", hazard="flood", severity=1.0),
    ]
    res = triage.triage(events, "indore_pilot")
    assert res["matched_total"] == 2
    assert res["alerts"][0]["event_id"] == "severe"
    assert res["alerts"][0]["priority"] > res["alerts"][1]["priority"]


def test_unmatched_events_excluded(stub_tile):
    res = triage.triage([_ev(headline="over Chennai")], "indore_pilot")
    assert res["matched_total"] == 0
    assert res["alerts"] == []


def test_brief_markdown_has_header_and_table(stub_tile):
    res = triage.triage([_ev(event_id="e", hazard="flood", severity=0.9)], "indore_pilot")
    md = brief.to_markdown(res, generated_at="2026-06-23T00:00:00+00:00")
    assert "# Alert Triage — indore_pilot" in md
    assert "| # | Priority |" in md
    assert "flood" in md


def test_brief_markdown_empty_state(stub_tile):
    res = triage.triage([_ev(headline="over Chennai")], "indore_pilot")
    md = brief.to_markdown(res)
    assert "No active hazards correlate" in md


def test_to_json_stamps_generated_at(stub_tile):
    res = triage.triage([_ev()], "indore_pilot")
    payload = brief.to_json(res, generated_at="2026-06-23T00:00:00+00:00")
    assert payload["generated_at"] == "2026-06-23T00:00:00+00:00"
    assert payload["region"] == "indore_pilot"
