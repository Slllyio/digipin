"""Snapshot profiles: the numbers drift is measured on, persisted between runs."""
from __future__ import annotations

import json
from pathlib import Path

_EMPTY = (None, "")


def profile(payload: dict) -> dict:
    """Row count, timestamp and per-field null rate of a ``latest.json`` payload. Pure."""
    records = [r for r in (payload.get("records") or []) if isinstance(r, dict)]
    fields: set[str] = set()
    for r in records:
        fields.update(r.keys())
    null_rates = {}
    if records:
        for f in sorted(fields):
            nulls = sum(1 for r in records if r.get(f) in _EMPTY or r.get(f) == [])
            null_rates[f] = round(nulls / len(records), 4)
    return {
        "generated_at": payload.get("generated_at_iso") or payload.get("generated_at"),
        "count": len(records),
        "null_rates": null_rates,
    }


def load_state(path: Path) -> dict:
    """Previous run's ``{source_id: profile}``; empty when absent or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data.get("profiles", {}) if isinstance(data, dict) else {}


def save_state(path: Path, profiles: dict, generated_at: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"generated_at": generated_at, "profiles": profiles}, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")
