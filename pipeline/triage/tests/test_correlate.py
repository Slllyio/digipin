"""Event → region correlation (geo bbox + name gazetteer)."""
from __future__ import annotations

import pytest

from pipeline.triage import correlate
from pipeline.triage.model import HazardEvent

pytestmark = pytest.mark.unit


def _ev(**kw):
    base = dict(source="x", event_id="1", hazard="flood", severity=0.5)
    base.update(kw)
    return HazardEvent(**base)


def test_geo_event_inside_bbox_matches_by_coords():
    e = _ev(source="usgs_earthquakes", hazard="earthquake", lat=22.7, lng=75.85)
    m = correlate.match_events([e], "indore_pilot")
    assert len(m) == 1 and m[0].matched_by == "coords"


def test_geo_event_outside_bbox_is_dropped():
    e = _ev(source="usgs_earthquakes", hazard="earthquake", lat=0.0, lng=0.0)
    assert correlate.match_events([e], "indore_pilot") == []


def test_name_match_on_headline():
    e = _ev(source="ndma_sachet", headline="Heavy rain over Indore district")
    m = correlate.match_events([e], "indore_pilot")
    assert len(m) == 1 and m[0].matched_by == "name"


def test_name_no_match_for_other_city():
    e = _ev(source="ndma_sachet", headline="Heavy rain over Chennai")
    assert correlate.match_events([e], "indore_pilot") == []


def test_gdacs_country_match():
    e = _ev(source="gdacs_disasters", headline="Green flood alert in India", area_text="India")
    m = correlate.match_events([e], "indore_pilot")
    assert len(m) == 1 and m[0].matched_by == "name"


def test_imd_district_id_match_via_event_id_prefix():
    e = _ev(source="imd_warnings", event_id="423:0", headline="", area_text="")
    m = correlate.match_events([e], "indore_pilot")
    assert len(m) == 1 and m[0].matched_by == "name"
