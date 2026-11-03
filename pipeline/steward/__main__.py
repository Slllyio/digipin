"""CLI for the Pipeline Steward.

    python -m pipeline.steward                 # check; write data/steward/{report.json,report.md,state.json}
    python -m pipeline.steward --stdout        # print the Markdown report, write nothing
    python -m pipeline.steward --strict        # exit 1 when any check fails (for CI gates)
    python -m pipeline.steward scaffold my_feed --url https://example.org/feed.json --format json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pipeline._lib import io

from . import report, scaffold, steward
from .inventory import REPO_ROOT
from .profile import load_state, save_state


def _check(args, log) -> int:
    out = Path(args.out) if args.out else REPO_ROOT / "data" / "steward"
    previous = load_state(out / "state.json")
    result = steward.run(previous=previous)
    markdown = report.to_markdown(result)
    if args.stdout:
        print(markdown)
    else:
        out.mkdir(parents=True, exist_ok=True)
        public = {k: v for k, v in result.items() if k != "profiles"}
        (out / "report.json").write_text(json.dumps(public, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (out / "report.md").write_text(markdown, encoding="utf-8")
        save_state(out / "state.json", result["profiles"], result["generated_at"])
        log.info("steward: %s — %d finding(s) → %s", result["status"], len(result["findings"]), out)
    return 1 if args.strict and result["status"] == "fail" else 0


def _scaffold(args, log) -> int:
    try:
        touched = scaffold.scaffold(args.id, args.url, args.format, args.title or "",
                                    tuple(args.env or ()), force=args.force)
    except (ValueError, FileExistsError) as exc:
        log.error("scaffold: %s", exc)
        return 2
    for p in touched:
        log.info("scaffold: wrote %s", p.relative_to(REPO_ROOT))
    log.info("next: python -m scrapers.cli %s -v, then pytest scrapers/sources/tests", args.id)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DigiPin Pipeline Steward — data pipeline health + source scaffolding")
    sub = ap.add_subparsers(dest="cmd")
    ap.add_argument("--out", default=None, help="output dir (default: data/steward/)")
    ap.add_argument("--stdout", action="store_true", help="print the Markdown report; write no files")
    ap.add_argument("--strict", action="store_true", help="exit 1 when overall status is fail")

    sc = sub.add_parser("scaffold", help="generate a new conforming scraper source")
    sc.add_argument("id", help="source id, snake_case (e.g. cwc_flood_levels)")
    sc.add_argument("--url", required=True, help="https feed URL")
    sc.add_argument("--format", choices=scaffold.FORMATS, default="json")
    sc.add_argument("--title", default="", help="human-readable source name")
    sc.add_argument("--env", nargs="*", help="env vars the source needs (REQUIRED_ENV)")
    sc.add_argument("--force", action="store_true", help="overwrite an existing module/schema")

    args = ap.parse_args(argv)
    log = io.setup_logging("steward")
    if args.cmd == "scaffold":
        return _scaffold(args, log)
    return _check(args, log)


if __name__ == "__main__":
    sys.exit(main())
