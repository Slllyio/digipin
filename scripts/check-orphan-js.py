#!/usr/bin/env python3
"""Reject any js/*.js file that no HTML page references via <script src>.

The bug class this catches:
    A module is committed, lint-clean, unit-tested via vm.runInNewContext,
    even has documented data contracts — but no <script> tag in any
    index.html actually loads it. The whole feature ships dark.

    During the 2026-05-25 live-smoke pass, eight such orphans were
    discovered in one go:
        realtime-alerts.js, realtime-imd.js, realtime-quakes.js,
        realtime-flood.js, flood-scs.js, flood-inundation.js,
        flood-animation.js, data-fetcher-cache.js

How it works:
    1. Enumerate every js/*.js committed to the repo.
    2. Grep every *.html for `<script ...src="...js/<name>.js"...>`
       references — including both `js/foo.js` and `../js/foo.js` paths
       (the guna-twin-city/ sub-app uses the latter).
    3. Anything in (1) not in (2) is an orphan — fail.

Allowlist:
    If a script is intentionally orphaned (e.g. loaded dynamically via
    fetch + new Function, or a dev-only utility), tag it via a
    top-of-file marker comment:
        // dev:orphan-allowed  reason: <human-readable explanation>

Exit codes:
    0  no orphans (or only allowlisted ones)
    1  at least one unallowlisted orphan exists
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS_DIR = ROOT / "js"

# Pattern for HTML <script src> references — handles single/double quotes
# and optional `../` prefix used by sub-apps.
HTML_SCRIPT_RE = re.compile(
    r"""<script[^>]*\bsrc=["'](?:\.\./)?js/([^"']+\.js)["']""",
    re.IGNORECASE,
)

# Marker that exempts a file from the check.
ORPHAN_OK_RE = re.compile(r"^\s*//\s*dev:orphan-allowed", re.MULTILINE)


def main() -> int:
    if not JS_DIR.is_dir():
        print(f"::error::expected js/ directory at {JS_DIR}", file=sys.stderr)
        return 1

    on_disk = {p.name for p in JS_DIR.glob("*.js")}

    referenced: set[str] = set()
    for html in ROOT.rglob("*.html"):
        # Skip vendored / node_modules / docs build output
        if any(part in {"node_modules", ".git", "build", "dist"} for part in html.parts):
            continue
        text = html.read_text(encoding="utf-8", errors="replace")
        referenced.update(HTML_SCRIPT_RE.findall(text))

    orphans = sorted(on_disk - referenced)
    if not orphans:
        print(f"OK — every js/*.js (count={len(on_disk)}) is referenced by at least one HTML page.")
        return 0

    # Apply the allowlist marker
    real_orphans: list[str] = []
    allowlisted: list[str] = []
    for fname in orphans:
        path = JS_DIR / fname
        head = path.read_text(encoding="utf-8", errors="replace")[:500]
        if ORPHAN_OK_RE.search(head):
            allowlisted.append(fname)
        else:
            real_orphans.append(fname)

    if allowlisted:
        print(f"INFO — {len(allowlisted)} allowlisted orphan(s): {', '.join(allowlisted)}")

    if not real_orphans:
        print("OK — all orphans are explicitly allowlisted.")
        return 0

    print("::error::orphaned js/*.js modules — code is committed but no HTML loads it:")
    for fname in real_orphans:
        print(f"  - js/{fname}")
    print()
    print("Fix:")
    print("  1. Add a <script defer src=\"js/<name>.js\"></script> to index.html, OR")
    print("  2. If the file is intentionally not loaded, add this marker on line 1:")
    print("     // dev:orphan-allowed  reason: <why it isn't loaded>")
    print()
    print("Background: the 2026-05-25 live-smoke pass found 8 such orphans —")
    print("entire features (NDMA alerts, IMD warnings, earthquakes, flood")
    print("forecast, IndexedDB cache) shipped dark because no HTML loaded them.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
