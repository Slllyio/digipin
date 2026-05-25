"""JSONL + CSV writers and resume-via-seen-ids helper.

Mirrors the Astro_Data scraper's output pattern:
  - JSONL — one record per line, full structured data (preferred for
    machine consumption / re-ingest)
  - CSV — flat view of the same data (preferred for spot-checking)
  - seen_ids.txt — newline-delimited record IDs; re-runs skip them so
    a long crawl can resume safely after interruption.

Each source owns its own output directory: data/realtime/<source>/.
"""

from __future__ import annotations

import csv
import json
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def load_seen_ids(seen_file: Path) -> set[str]:
    """Read seen_ids.txt; return empty set if absent."""
    if not seen_file.exists():
        return set()
    return {line.strip() for line in seen_file.read_text(encoding="utf-8").splitlines() if line.strip()}


def append_seen_id(seen_file: Path, record_id: str) -> None:
    seen_file.parent.mkdir(parents=True, exist_ok=True)
    with seen_file.open("a", encoding="utf-8") as f:
        f.write(f"{record_id}\n")


def _to_dict(record: Any) -> dict:
    if is_dataclass(record):
        return asdict(record)
    if isinstance(record, dict):
        return record
    raise TypeError(f"cannot serialize {type(record).__name__} — pass dict or @dataclass")


def write_jsonl(records: Iterable[Any], jsonl_path: Path) -> int:
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with jsonl_path.open("a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(_to_dict(r), ensure_ascii=False) + "\n")
            count += 1
    return count


def write_csv(records: Iterable[Any], csv_path: Path, fieldnames: list[str]) -> int:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not csv_path.exists()
    count = 0
    with csv_path.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        if new_file:
            writer.writeheader()
        for r in records:
            row = _to_dict(r)
            # flatten any list fields by joining with semicolons (Astro convention)
            row = {k: ("; ".join(v) if isinstance(v, list) else v) for k, v in row.items()}
            writer.writerow(row)
            count += 1
    return count


def write_latest_snapshot(records: Iterable[Any], snapshot_path: Path) -> int:
    """Overwrite a `latest.json` snapshot — small enough for the frontend
    to fetch without pagination. Use sparingly (only for sources where
    the entire feed is a small set, e.g. active disaster alerts).

    Always stamps `generated_at_iso` so downstream timeliness checks
    (scrapers/lib/quality.py) can detect stale snapshots after a source
    flap. ISO 8601 with `Z` suffix per spec; not localised."""
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    payload = [_to_dict(r) for r in records]
    generated_at_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    snapshot_path.write_text(
        json.dumps(
            {
                "generated_at_iso": generated_at_iso,
                "count": len(payload),
                "records": payload,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return len(payload)
