"""Feed normalization → HazardEvent."""
from __future__ import annotations

import pytest

from pipeline.triage import feeds

pytestmark = pytest.mark.unit


def test_ndma_severity_and_hazard():
    snap = {"records": [{"id": "1", "headline": "Flood over Indore", "severity": "Severe", "category": "Met-Flood", "area": ""}]}
    evs = feeds.normalize("ndma_sachet", snap)
    assert len(evs) == 1
    e = evs[0]
    assert e.hazard == "flood"
    assert e.severity == 0.75
    assert e.has_coords() is False
    assert "Indore" in e.headline


def test_usgs_quake_severity_scales_with_magnitude():
    snap = {"records": [
        {"id": "a", "magnitude": 4.5, "latitude": 22.7, "longitude": 75.8, "place": "near Indore", "tsunami": 0},
        {"id": "b", "magnitude": 7.5, "latitude": 0, "longitude": 0, "place": "x", "tsunami": 0},
    ]}
    evs = feeds.normalize("usgs_earthquakes", snap)
    assert evs[0].hazard == "earthquake"
    assert evs[0].has_coords()
    assert evs[1].severity > evs[0].severity


def test_usgs_tsunami_raises_severity():
    snap = {"records": [{"id": "t", "magnitude": 6.0, "latitude": 1, "longitude": 2, "tsunami": 1}]}
    e = feeds.normalize("usgs_earthquakes", snap)[0]
    assert e.severity >= 0.9


def test_gdacs_hazard_map_and_level():
    snap = {"records": [{"id": "1", "event_type": "FL", "alert_level": "Red", "alert_score": 1.0,
                         "title": "Flood in India", "country": "India", "published_utc": "Tue, 02 Jun 2026 05:45:56 GMT"}]}
    e = feeds.normalize("gdacs_disasters", snap)[0]
    assert e.hazard == "flood"
    assert e.severity == 1.0
    assert e.area_text == "India"
    assert e.time_utc.startswith("2026-06-02")  # RFC-822 → ISO


def test_empty_and_unknown_and_forecast_sources():
    assert feeds.normalize("ndma_sachet", {"records": []}) == []
    assert feeds.normalize("ndma_sachet", {}) == []
    assert feeds.normalize("bogus", {"records": [{}]}) == []
    # imd_cityforecast is a plain forecast — deliberately not a hazard feed.
    assert feeds.normalize("imd_cityforecast", {"records": [{"city_name": "Indore"}]}) == []


def test_bad_record_is_skipped_not_fatal():
    snap = {"records": [None, {"id": "ok", "magnitude": 5.0, "latitude": 1, "longitude": 2}]}
    evs = feeds.normalize("usgs_earthquakes", snap)
    assert len(evs) == 1 and evs[0].event_id == "ok"
