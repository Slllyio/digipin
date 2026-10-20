"""Behaviour of the API-key-gated sources (IMD x3, OpenAQ) when the key is
missing or rejected.

Before these guards, a missing secret made every cron run overwrite
latest.json with `count: 0`, and a rejected key did the same after ~5
minutes of retry backoff. Both looked identical to "no alerts today".
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import pytest

from scrapers import cli
from scrapers.lib.http import PoliteClient, SourceUnavailable
from scrapers.sources import imd_cityforecast, imd_nowcast, imd_warnings, openaq_india

KEYED = [imd_warnings, imd_nowcast, imd_cityforecast, openaq_india]
ALL_KEYS = {"IMD_API_KEY": "k", "IMD_API_TOKEN": "t", "OPENAQ_API_KEY": "o"}


def _seed_snapshot(out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    snap = out_dir / "latest.json"
    snap.write_text(json.dumps({"generated_at_iso": "2026-01-01T00:00:00Z",
                                "count": 1, "records": [{"id": "keep-me"}]}))
    return snap


@pytest.mark.parametrize("module", KEYED, ids=lambda m: m.SOURCE_ID)
def test_missing_key_leaves_snapshot_untouched(module, tmp_path, monkeypatch):
    for k in ALL_KEYS:
        monkeypatch.delenv(k, raising=False)
    snap = _seed_snapshot(tmp_path)
    before = snap.read_text()

    with mock.patch.object(module, "fetch") as fetch:
        rc = cli.main([module.SOURCE_ID, "--output-dir", str(tmp_path)])

    assert rc == 0
    fetch.assert_not_called()
    assert snap.read_text() == before


@pytest.mark.parametrize("module", KEYED, ids=lambda m: m.SOURCE_ID)
def test_all_requests_failing_raises_source_unavailable(module, monkeypatch):
    for k, v in ALL_KEYS.items():
        monkeypatch.setenv(k, v)
    client = PoliteClient(delay=0, jitter=0)
    with mock.patch.object(client, "get", return_value=None), \
         mock.patch.object(client, "polite_sleep"):
        with pytest.raises(SourceUnavailable):
            module.fetch(client)


def test_cli_keeps_snapshot_and_fails_when_source_unavailable(tmp_path, monkeypatch):
    for k, v in ALL_KEYS.items():
        monkeypatch.setenv(k, v)
    snap = _seed_snapshot(tmp_path)
    before = snap.read_text()

    with mock.patch.object(imd_warnings, "fetch", side_effect=SourceUnavailable("401")):
        rc = cli.main(["imd_warnings", "--output-dir", str(tmp_path)])

    assert rc == 1
    assert snap.read_text() == before


def test_partial_success_still_writes(monkeypatch):
    """One district answering is enough — the rest are logged and skipped."""
    for k, v in ALL_KEYS.items():
        monkeypatch.setenv(k, v)
    client = PoliteClient(delay=0, jitter=0)
    body = json.dumps({"data": [{"color": "orange", "date": "2026-10-20"}]}).encode()
    responses = iter([body] + [None] * (len(imd_warnings.DEFAULT_DISTRICTS) - 1))
    with mock.patch.object(client, "get", side_effect=lambda *a, **k: next(responses)), \
         mock.patch.object(client, "polite_sleep"):
        rows = imd_warnings.fetch(client)
    assert len(rows) == 1
    assert rows[0].severity == "Alert"


@pytest.mark.parametrize("status", [401, 403])
def test_auth_errors_are_not_retried(status):
    client = PoliteClient(delay=0, jitter=0)
    resp = mock.Mock(status_code=status, url="https://example.test/x", content=b"")
    with mock.patch.object(client._session, "get", return_value=resp) as get, \
         mock.patch("scrapers.lib.http.time.sleep"):
        assert client.get("https://example.test/x") is None
    assert get.call_count == 1
