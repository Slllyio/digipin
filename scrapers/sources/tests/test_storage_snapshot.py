"""Contract tests for scrapers/lib/storage.py:write_latest_snapshot.

The snapshot writer is the choke-point that stamps `generated_at_iso`
into every `latest.json` we ship. The downstream timeliness check
(quality.py) reads exactly that field — so its absence silently breaks
every snapshot's freshness signal across the whole pipeline.

These tests lock the contract: the writer must produce
`{generated_at_iso, count, records}` in that order, with a
parseable UTC Z-stamp.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from scrapers.lib.storage import write_latest_snapshot


ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _write_and_read(records: list[dict]) -> dict:
    with TemporaryDirectory() as td:
        path = Path(td) / "latest.json"
        n = write_latest_snapshot(records, path)
        assert n == len(records)
        return json.loads(path.read_text(encoding="utf-8"))


def test_snapshot_includes_generated_at_iso():
    payload = _write_and_read([{"id": "a", "magnitude": 4.2}])
    assert "generated_at_iso" in payload, "snapshot must include generated_at_iso"
    assert ISO_Z.match(payload["generated_at_iso"]), (
        f"timestamp {payload['generated_at_iso']!r} must be ISO 8601 UTC with Z suffix"
    )


def test_snapshot_timestamp_is_recent():
    payload = _write_and_read([])
    written = datetime.strptime(payload["generated_at_iso"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    age_s = (datetime.now(timezone.utc) - written).total_seconds()
    assert 0 <= age_s < 5, f"snapshot timestamp drift {age_s:.3f}s — clock or logic issue"


def test_snapshot_preserves_records_and_count():
    records = [{"id": "1", "v": 10}, {"id": "2", "v": 20}, {"id": "3", "v": 30}]
    payload = _write_and_read(records)
    assert payload["count"] == 3
    assert payload["records"] == records


def test_empty_records_are_stamped_too():
    """An empty feed is still a freshness signal — we want the timestamp
    even when there's nothing to report, so the frontend can prove
    the cron is still alive."""
    payload = _write_and_read([])
    assert payload["count"] == 0
    assert payload["records"] == []
    assert "generated_at_iso" in payload
