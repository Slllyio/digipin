"""Pure checks: freshness, volume, null-rate drift, wiring, overall status."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from pipeline.steward import checks
from pipeline.steward.inventory import Source
from pipeline.steward.profile import profile

pytestmark = pytest.mark.unit

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)


def _iso(delta: timedelta) -> str:
    return (NOW - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_fresh_snapshot_has_no_findings():
    assert checks.check_freshness("usgs", _iso(timedelta(minutes=20)), NOW) == []


def test_late_snapshot_warns_and_dead_one_fails():
    late = checks.check_freshness("usgs", _iso(timedelta(hours=9)), NOW)
    dead = checks.check_freshness("usgs", _iso(timedelta(days=10)), NOW)
    assert [f["severity"] for f in late] == ["warn"]
    assert "9h" in late[0]["message"]
    assert [f["severity"] for f in dead] == ["fail"]
    assert "10d" in dead[0]["message"]


def test_per_source_window_and_offset_timestamps():
    # imd_cityforecast gets a 24h window; offset-style timestamps parse too.
    assert checks.check_freshness("imd_cityforecast", (NOW - timedelta(hours=20)).isoformat(), NOW) == []


def test_missing_timestamp_fails():
    assert checks.check_freshness("x", None, NOW)[0]["severity"] == "fail"


def test_went_empty_fails_but_keyed_empty_warns_with_secret_hint():
    gone = checks.check_volume("ncs", {"count": 0}, {"count": 150})
    keyed = checks.check_volume("imd", {"count": 0}, None, ("IMD_API_KEY",))
    quiet = checks.check_volume("gdacs", {"count": 0}, None)
    assert gone[0]["severity"] == "fail"
    assert keyed[0]["severity"] == "warn" and "IMD_API_KEY" in keyed[0]["hint"]
    assert quiet[0]["severity"] == "info"


def test_row_drop_warns_only_past_half():
    assert checks.check_volume("s", {"count": 60}, {"count": 100}) == []
    assert checks.check_volume("s", {"count": 40}, {"count": 100})[0]["check"] == "volume"


def test_null_rate_jump_is_flagged():
    prev = profile({"records": [{"id": "1", "mag": 5}, {"id": "2", "mag": 6}]})
    cur = profile({"records": [{"id": "1", "mag": None}, {"id": "2", "mag": ""}, {"id": "3", "mag": 4}]})
    out = checks.check_null_rates("s", cur, prev)
    assert len(out) == 1 and "'mag'" in out[0]["message"]
    assert checks.check_null_rates("s", cur, None) == []


def test_profile_counts_and_rates():
    p = profile({"generated_at_iso": "2026-10-21T00:00:00Z",
                 "records": [{"id": "a", "x": None}, {"id": "b", "x": 1, "y": []}]})
    assert p["count"] == 2
    assert p["null_rates"] == {"id": 0.0, "x": 0.5, "y": 1.0}


def test_wiring_gaps():
    from pathlib import Path

    full = Source("ok", module_path=Path("m.py"), has_schema=True, in_matrix=True, in_quality=True,
                  snapshot_path=Path("l.json"))
    assert checks.check_wiring(full) == []
    bare = Source("new", module_path=Path("m.py"))
    msgs = " ".join(f["message"] for f in checks.check_wiring(bare))
    assert "Schema" in msgs and "matrix" in msgs
    ghost = Source("ghost", in_matrix=True)
    assert checks.check_wiring(ghost)[0]["severity"] == "fail"


def test_worst():
    assert checks.worst([]) == "ok"
    assert checks.worst([{"severity": "info"}, {"severity": "warn"}]) == "warn"
    assert checks.worst([{"severity": "warn"}, {"severity": "fail"}]) == "fail"
