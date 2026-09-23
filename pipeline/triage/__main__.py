"""CLI: build the alert-triage brief for a region.

    python -m pipeline.triage                 # default region, writes data/triage/<region>/
    python -m pipeline.triage --region pune
    python -m pipeline.triage --stdout        # print the Markdown brief, write nothing

Deterministic core only. Optional LLM narration and webhook delivery are gated on
env vars and skip cleanly when unset (mirrors the scrapers' key-gated feeds):
  TRIAGE_WEBHOOK_URL   POST the JSON brief here after building.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from pipeline._lib import io, regions

from . import brief, feeds, triage


def build(region_id=None, realtime_dir=None) -> tuple:
    """Load feeds, run triage, return (region_id, result)."""
    region_id = region_id or regions.get_default_region_name()
    events = feeds.load_events(realtime_dir=realtime_dir)
    return region_id, triage.triage(events, region_id)


def _maybe_deliver(payload: dict, log) -> None:
    """POST the brief to TRIAGE_WEBHOOK_URL if configured; skip otherwise."""
    import os

    url = os.environ.get("TRIAGE_WEBHOOK_URL")
    if not url:
        return
    try:
        import urllib.request

        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=15)  # noqa: S310 — operator-supplied URL
        log.info("triage: delivered brief to webhook")
    except Exception as exc:  # noqa: BLE001 — delivery is best-effort
        log.warning("triage: webhook delivery failed: %s", exc)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DigiPin alert triage — fuse hazard feeds with the score tile")
    ap.add_argument("--region", default=None, help="region id (default: DIGIPIN_REGION or indore_pilot)")
    ap.add_argument("--out", default=None, help="output dir (default: data/triage/<region>/)")
    ap.add_argument("--stdout", action="store_true", help="print the Markdown brief; write no files")
    args = ap.parse_args(argv)

    log = io.setup_logging("triage")
    region_id, result = build(args.region)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    markdown = brief.to_markdown(result, generated_at=generated_at)
    if args.stdout:
        print(markdown)
        return 0

    payload = brief.to_json(result, generated_at=generated_at)
    out = Path(args.out) if args.out else io.data_dir("triage", region_id)
    out.mkdir(parents=True, exist_ok=True)
    (out / "latest.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "brief.md").write_text(markdown, encoding="utf-8")
    log.info("triage: %d/%d hazards matched → %s", result["matched_total"], result["event_total"], out)

    _maybe_deliver(payload, log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
