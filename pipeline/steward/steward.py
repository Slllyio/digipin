"""Run every check over the inventory and the derived data products."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from . import checks, inventory
from .profile import profile

# Committed outputs of other scheduled jobs: (label, glob under data/, timestamp key, stale-after seconds).
PRODUCTS = [
    ("triage brief", "triage/*/latest.json", "generated_at", 6 * checks.HOUR),
]


def _load(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def check_sources(sources: dict, previous: dict, now: datetime) -> tuple[list[dict], dict]:
    """Findings + fresh profiles for every scraper source."""
    findings: list[dict] = []
    profiles: dict = {}
    for sid in sorted(sources):
        src = sources[sid]
        findings += checks.check_wiring(src)
        if src.snapshot_path is None:
            continue
        payload = _load(src.snapshot_path)
        if payload is None:
            findings.append(checks.finding(sid, "contract", "fail", "latest.json is not valid JSON"))
            continue
        prof = profile(payload)
        profiles[sid] = prof
        prev = previous.get(sid)
        if src.in_matrix:
            findings += checks.check_freshness(sid, prof["generated_at"], now)
        findings += checks.check_volume(sid, prof, prev, src.required_env)
        findings += checks.check_null_rates(sid, prof, prev)
        findings += checks.check_contract(src)
    return findings, profiles


def check_products(data_root: Path, now: datetime) -> list[dict]:
    """Freshness of products written by other scheduled workflows."""
    findings = []
    for label, pattern, key, stale_after in PRODUCTS:
        for path in sorted(data_root.glob(pattern)):
            name = f"{label} ({path.parent.name})"
            payload = _load(path)
            if payload is None:
                findings.append(checks.finding(name, "contract", "fail", f"{path.name} is not valid JSON"))
                continue
            for f in checks.check_freshness(name, payload.get(key), now, stale_after):
                f["hint"] = "its scheduled workflow is not running; scheduled workflows only run from the default branch"
                findings.append(f)
    return findings


def run(root: Path = inventory.REPO_ROOT, previous: dict | None = None, now: datetime | None = None) -> dict:
    """Full steward pass → ``{status, generated_at, sources, findings, profiles}``."""
    now = now or datetime.now().astimezone()
    sources = inventory.discover(root)
    findings, profiles = check_sources(sources, previous or {}, now)
    findings += check_products(root / "data", now)
    findings.sort(key=lambda f: (-checks.SEVERITY_ORDER[f["severity"]], f["source"], f["check"]))
    return {
        "status": checks.worst(findings),
        "generated_at": now.isoformat(timespec="seconds"),
        "source_count": len(sources),
        "sources": {
            sid: {
                "status": checks.worst([f for f in findings if f["source"] == sid]),
                "rows": profiles.get(sid, {}).get("count"),
                "generated_at": profiles.get(sid, {}).get("generated_at"),
                "required_env": list(src.required_env),
            }
            for sid, src in sorted(sources.items())
        },
        "findings": findings,
        "profiles": profiles,
    }
