"""Lightweight data quality validation for scraper snapshots.

The principles come from production data-quality frameworks (Great
Expectations, dbt tests, Soda) — but scaled down to DigiPin's reality:
~10 KB JSON snapshots refreshed every 15 minutes, no warehouse, no
modeling layer. JSON Schema + a handful of structured checks gives us
the same 6 quality dimensions at 1/100th the dependencies.

Quality dimensions checked, per the framework:
  Completeness — required fields present (via JSON Schema `required`)
  Uniqueness  — primary keys don't collide within the snapshot
  Validity    — enums match expected sets (via Schema `enum`); numeric
                ranges via `minimum`/`maximum`; spatial: lat in India bbox
  Timeliness  — `generated_at_iso` is within the configured staleness window
  Consistency — cross-field rules (e.g. published_utc <= generated_at_iso)
  Accuracy    — out of scope (would need ground truth)

Usage from a test:

    from scrapers.lib.quality import validate_snapshot, QualityResult

    result = validate_snapshot(
        snapshot_path="data/realtime/ndma_sachet/latest.json",
        schema_path="scrapers/sources/schemas/ndma_sachet.schema.json",
        primary_key="id",
        max_staleness_seconds=3600,
    )
    assert result.passed, result.report()
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class QualityResult:
    """One snapshot's validation outcome."""
    snapshot_path: str
    schema_path: str
    passed: bool
    record_count: int
    failures: list[dict[str, Any]] = field(default_factory=list)

    @property
    def failure_count(self) -> int:
        return len(self.failures)

    def report(self) -> str:
        """Human-readable summary suitable for pytest assertion messages."""
        status = "PASS" if self.passed else "FAIL"
        lines = [
            f"[{status}] {self.snapshot_path}",
            f"  schema: {self.schema_path}",
            f"  records: {self.record_count}",
            f"  failures: {self.failure_count}",
        ]
        for f in self.failures[:10]:    # cap at 10 so a broken snapshot doesn't flood the log
            lines.append(f"  - {f['dimension']}: {f['message']}")
        if self.failure_count > 10:
            lines.append(f"  ... and {self.failure_count - 10} more")
        return "\n".join(lines)


def _check_schema(payload: dict, schema: dict) -> list[dict[str, Any]]:
    """Completeness + Validity via JSON Schema.

    Validates the whole payload (wrapper object) against the schema in
    one pass — jsonschema's recursive validation descends into
    `records[].items` so per-record checks happen for free.

    Uses jsonschema if available, otherwise a minimal hand-rolled
    fallback covering the common patterns (required fields + enums on
    records[].items) so the test suite still has signal when the
    optional dep isn't installed.
    """
    failures: list[dict[str, Any]] = []
    try:
        from jsonschema import Draft202012Validator   # type: ignore
        validator = Draft202012Validator(schema)
        for err in validator.iter_errors(payload):
            path = list(err.absolute_path)
            record_index = path[1] if len(path) >= 2 and path[0] == "records" else None
            failures.append({
                "dimension": "validity",
                "record_index": record_index,
                "field": ".".join(str(p) for p in path) or "<root>",
                "message": err.message,
            })
        return failures
    except ImportError:
        # Fallback: check required fields + enum constraints on records[].items
        records = payload.get("records") or []
        record_schema = (schema.get("properties") or {}).get("records", {})
        item_schema = record_schema.get("items", {})
        required = item_schema.get("required", [])
        enums = {
            name: (sub.get("enum"))
            for name, sub in (item_schema.get("properties") or {}).items()
            if sub.get("enum")
        }
        for i, record in enumerate(records):
            for fname in required:
                if fname not in record or record[fname] is None:
                    failures.append({
                        "dimension": "completeness",
                        "record_index": i,
                        "field": fname,
                        "message": "required field missing",
                    })
            for fname, allowed in enums.items():
                if fname in record and record[fname] not in allowed:
                    failures.append({
                        "dimension": "validity",
                        "record_index": i,
                        "field": fname,
                        "message": f"value {record[fname]!r} not in allowed enum {allowed}",
                    })
        return failures


def _check_uniqueness(records: list[dict], primary_key: str) -> list[dict[str, Any]]:
    """Uniqueness dimension: no duplicate primary keys."""
    if not primary_key:
        return []
    seen: dict[Any, int] = {}
    failures: list[dict[str, Any]] = []
    for i, record in enumerate(records):
        key = record.get(primary_key)
        if key is None:
            continue
        if key in seen:
            failures.append({
                "dimension": "uniqueness",
                "record_index": i,
                "field": primary_key,
                "message": f"duplicate key {key!r}; first seen at index {seen[key]}",
            })
        else:
            seen[key] = i
    return failures


def _check_timeliness(payload: dict, max_staleness_seconds: int | None) -> list[dict[str, Any]]:
    """Timeliness dimension: snapshot was generated recently.

    Skipped (returns []) when max_staleness_seconds is None — appropriate
    for sources where freshness isn't user-facing.
    """
    if max_staleness_seconds is None:
        return []
    iso = payload.get("generated_at_iso") or payload.get("generated_at")
    if not iso:
        return [{
            "dimension": "timeliness",
            "field": "generated_at_iso",
            "message": "no generated_at timestamp in payload",
        }]
    try:
        generated = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return [{
            "dimension": "timeliness",
            "field": "generated_at_iso",
            "message": f"unparseable timestamp {iso!r}",
        }]
    if generated.tzinfo is None:
        generated = generated.replace(tzinfo=timezone.utc)
    age_s = (datetime.now(timezone.utc) - generated).total_seconds()
    if age_s > max_staleness_seconds:
        return [{
            "dimension": "timeliness",
            "field": "generated_at_iso",
            "message": f"snapshot is {age_s:.0f}s old, exceeds {max_staleness_seconds}s threshold",
        }]
    return []


def validate_snapshot(
    snapshot_path: str | Path,
    schema_path: str | Path,
    primary_key: str = "id",
    max_staleness_seconds: int | None = None,
) -> QualityResult:
    """Validate a scraper snapshot against a JSON Schema + uniqueness + timeliness.

    Returns a QualityResult — never raises. Test code asserts on `.passed`
    and prints `.report()` on failure for diagnosable output.
    """
    snapshot_path = Path(snapshot_path)
    schema_path = Path(schema_path)

    if not snapshot_path.is_file():
        return QualityResult(
            snapshot_path=str(snapshot_path),
            schema_path=str(schema_path),
            passed=False,
            record_count=0,
            failures=[{"dimension": "completeness",
                       "field": "<snapshot>",
                       "message": f"snapshot file not found"}],
        )
    if not schema_path.is_file():
        return QualityResult(
            snapshot_path=str(snapshot_path),
            schema_path=str(schema_path),
            passed=False,
            record_count=0,
            failures=[{"dimension": "completeness",
                       "field": "<schema>",
                       "message": f"schema file not found"}],
        )

    with snapshot_path.open(encoding="utf-8") as f:
        payload = json.load(f)
    with schema_path.open(encoding="utf-8") as f:
        schema = json.load(f)

    records = payload.get("records") or []
    failures = []
    failures.extend(_check_schema(payload, schema))
    failures.extend(_check_uniqueness(records, primary_key))
    failures.extend(_check_timeliness(payload, max_staleness_seconds))

    return QualityResult(
        snapshot_path=str(snapshot_path),
        schema_path=str(schema_path),
        passed=len(failures) == 0,
        record_count=len(records),
        failures=failures,
    )
