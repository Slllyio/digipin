"""CLI entry point — invokes one source at a time.

Examples:
    python -m scrapers.cli ndma_sachet
    python -m scrapers.cli ndma_sachet --delay 1.0 --no-snapshot
    python -m scrapers.cli ndma_sachet --output-dir custom/path -v

Output layout (per source):
    data/realtime/<source>/alerts.jsonl       # append-only full history
    data/realtime/<source>/alerts.csv         # flat mirror
    data/realtime/<source>/seen_ids.txt       # resume marker
    data/realtime/<source>/latest.json        # snapshot for the frontend
"""

from __future__ import annotations

import argparse
import importlib
import logging
import sys
from pathlib import Path

from .lib.http import PoliteClient
from .lib.storage import (
    append_seen_id,
    load_seen_ids,
    write_csv,
    write_jsonl,
    write_latest_snapshot,
)

log = logging.getLogger("scrapers.cli")

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "data" / "realtime"


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run a DigiPin real-time scraper for one source.",
    )
    p.add_argument("source", help="source module name, e.g. ndma_sachet")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--delay", type=float, default=0.6,
                   help="seconds between requests (jitter added on top)")
    p.add_argument("--output-dir", type=Path, default=None,
                   help=f"override output directory (default: {DEFAULT_OUTPUT_ROOT}/<source>)")
    p.add_argument("--no-snapshot", action="store_true",
                   help="skip writing latest.json (used by frontend)")
    p.add_argument("--no-resume", action="store_true",
                   help="ignore seen_ids.txt and re-emit all records (still appends)")
    p.add_argument("--insecure", action="store_true",
                   help="disable SSL verification (only for sites with broken certs)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        module = importlib.import_module(f"scrapers.sources.{args.source}")
    except ModuleNotFoundError:
        log.error("unknown source %r — add scrapers/sources/%s.py first", args.source, args.source)
        return 2

    source_id = getattr(module, "SOURCE_ID", args.source)
    out_dir = args.output_dir or (DEFAULT_OUTPUT_ROOT / source_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    jsonl_path = out_dir / "alerts.jsonl"
    csv_path = out_dir / "alerts.csv"
    seen_path = out_dir / "seen_ids.txt"
    snapshot_path = out_dir / "latest.json"

    seen = set() if args.no_resume else load_seen_ids(seen_path)
    client = PoliteClient(delay=args.delay, verify_ssl=not args.insecure)

    records = module.fetch(client)
    log.info("source %r returned %d record(s)", source_id, len(records))

    new_records = [r for r in records if module.key_for(r) not in seen]
    log.info("%d new record(s) after dedup against seen_ids.txt", len(new_records))

    if new_records:
        write_jsonl(new_records, jsonl_path)
        if hasattr(module, "Alert") and hasattr(module.Alert, "csv_fields"):
            write_csv(new_records, csv_path, module.Alert.csv_fields())
        for r in new_records:
            append_seen_id(seen_path, module.key_for(r))

    if not args.no_snapshot:
        # Snapshot reflects the *current* feed, not just new records, so
        # the frontend always sees a complete picture even when re-runs
        # produce zero new rows.
        wrote = write_latest_snapshot(records, snapshot_path)
        log.info("wrote latest.json snapshot (%d records)", wrote)

    log.info("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
