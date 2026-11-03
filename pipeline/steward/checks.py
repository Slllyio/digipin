"""The steward's checks. Each returns a list of findings; all are pure except
``check_contract`` (which reads the snapshot + schema through the existing
quality contract in ``scrapers/lib/quality.py``).

A finding is ``{"source", "check", "severity", "message", "hint"}`` with
severity ``fail`` (data is wrong or missing), ``warn`` (degraded or drifting),
or ``info``.
"""
from __future__ import annotations

from datetime import datetime, timezone

HOUR = 3600
DAY = 24 * HOUR

# How old a snapshot may get before it is called stale. Scrapes run every
# 15 min, so a few hours means several runs in a row did not land. Sources
# whose upstream publishes slowly get more slack.
DEFAULT_STALE_AFTER = 6 * HOUR
STALE_AFTER = {
    "imd_cityforecast": 1 * DAY,
}
# Beyond this the feed is treated as dead rather than late.
DEAD_AFTER = 7 * DAY

COUNT_DROP_RATIO = 0.5     # warn when rows fall below half of the previous run
NULL_RATE_JUMP = 0.25      # warn when a field's null rate rises this much (absolute)

SEVERITY_ORDER = {"ok": 0, "info": 1, "warn": 2, "fail": 3}


def finding(source: str, check: str, severity: str, message: str, hint: str = "") -> dict:
    return {"source": source, "check": check, "severity": severity, "message": message, "hint": hint}


def parse_ts(value) -> datetime | None:
    """ISO 8601 (``Z`` or offset) → aware datetime; None when missing/unparseable. Pure."""
    if not value or not isinstance(value, str):
        return None
    try:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def human_age(seconds: float) -> str:
    """Compact age: 45m, 7h, 3d. Pure."""
    if seconds < HOUR:
        return f"{max(0, int(seconds // 60))}m"
    if seconds < 2 * DAY:
        return f"{int(seconds // HOUR)}h"
    return f"{int(seconds // DAY)}d"


def check_freshness(source: str, generated_at, now: datetime, stale_after: int | None = None) -> list[dict]:
    """Timeliness: is the snapshot newer than its staleness window? Pure."""
    ts = parse_ts(generated_at)
    if ts is None:
        return [finding(source, "freshness", "fail", "snapshot has no readable generated timestamp")]
    limit = stale_after if stale_after is not None else STALE_AFTER.get(source, DEFAULT_STALE_AFTER)
    age = (now - ts).total_seconds()
    if age > DEAD_AFTER:
        return [finding(source, "freshness", "fail",
                        f"last refreshed {human_age(age)} ago ({ts:%Y-%m-%d %H:%MZ}); the feed looks dead",
                        "check the scraper's last run log; the upstream URL or format may have changed")]
    if age > limit:
        return [finding(source, "freshness", "warn",
                        f"last refreshed {human_age(age)} ago, older than the {human_age(limit)} window",
                        "recent scrape runs are failing or the upstream is down")]
    return []


def check_volume(source: str, current: dict, previous: dict | None, required_env=()) -> list[dict]:
    """Row-count drift vs the previous run, and empty snapshots. Pure."""
    out = []
    count = current.get("count", 0)
    prev_count = (previous or {}).get("count")
    if count == 0:
        if prev_count:
            out.append(finding(source, "volume", "fail", f"snapshot went empty (was {prev_count} rows last run)",
                               "the parser may no longer match the upstream format"))
        elif required_env:
            out.append(finding(source, "volume", "warn", "snapshot is empty",
                               f"needs {', '.join(required_env)}; check the Actions secrets and that the key is still valid"))
        else:
            out.append(finding(source, "volume", "info", "snapshot is empty (may be normal when nothing is active)"))
    elif prev_count and count < prev_count * COUNT_DROP_RATIO:
        out.append(finding(source, "volume", "warn", f"rows fell from {prev_count} to {count}",
                           "a partial fetch or an upstream filter change"))
    return out


def check_null_rates(source: str, current: dict, previous: dict | None) -> list[dict]:
    """Per-field null-rate drift vs the previous run. Pure."""
    if not previous or not current.get("count"):
        return []
    prev_rates = previous.get("null_rates") or {}
    out = []
    for f, rate in sorted((current.get("null_rates") or {}).items()):
        before = prev_rates.get(f)
        if before is not None and rate - before >= NULL_RATE_JUMP:
            out.append(finding(source, "null_rate", "warn",
                               f"field '{f}' is now {rate:.0%} empty (was {before:.0%})",
                               "the upstream may have renamed or dropped this field"))
    return out


def check_wiring(src) -> list[dict]:
    """Is the source fully wired: module, schema, CI matrix, quality row, snapshot? Pure."""
    sid = src.id
    out = []
    if src.module_path is None:
        if src.in_matrix:
            out.append(finding(sid, "wiring", "fail", "listed in the realtime-scrape matrix but has no scrapers/sources module"))
        return out
    if not src.has_schema:
        out.append(finding(sid, "wiring", "warn", "no JSON Schema contract",
                           f"add scrapers/sources/schemas/{sid}.schema.json"))
    if not src.in_matrix:
        out.append(finding(sid, "wiring", "warn", "not in the realtime-scrape.yml matrix, so CI never refreshes it"))
    if src.has_schema and not src.in_quality:
        out.append(finding(sid, "wiring", "warn", "schema exists but no row in test_snapshot_quality.py SOURCES"))
    if src.in_matrix and src.snapshot_path is None:
        out.append(finding(sid, "wiring", "warn", "no committed latest.json yet"))
    return out


def check_contract(src, primary_key: str = "id") -> list[dict]:
    """Re-run the schema + uniqueness contract from scrapers/lib/quality.py on the snapshot."""
    if not (src.schema_path and src.snapshot_path):
        return []
    from scrapers.lib.quality import validate_snapshot

    result = validate_snapshot(src.snapshot_path, src.schema_path, primary_key=primary_key)
    if result.passed:
        return []
    first = "; ".join(f["message"] for f in result.failures[:3])
    more = f" (+{result.failure_count - 3} more)" if result.failure_count > 3 else ""
    return [finding(src.id, "contract", "fail", f"{result.failure_count} contract failure(s): {first}{more}",
                    "the snapshot no longer matches its schema")]


def worst(findings: list[dict]) -> str:
    """Overall status: the most severe finding, or ``ok``. Pure."""
    level = "ok"
    for f in findings:
        if SEVERITY_ORDER[f["severity"]] > SEVERITY_ORDER[level]:
            level = f["severity"]
    return level
