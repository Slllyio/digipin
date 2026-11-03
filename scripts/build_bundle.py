#!/usr/bin/env python3
"""Bundle app.html's local scripts into one file for deployment.

app.html loads ~130 small `<script defer src="js/…">` modules. That is fine
in development (one file per module, stack traces that name the module) but
on a high-latency link the round trips dominate: first load measured at 13 s
on fast 3G and 52 s on slow 3G, most of it waiting for script requests
(docs/QA_LOG.md, 2026-10-21). Run at deploy time (.github/workflows/deploy.yml,
next to the GeoParquet copies), this script:

  1. concatenates every local deferred script, in document order, into
     js/app.bundle.js (a `;` between files so an IIFE that follows an
     unterminated expression is not parsed as a call; a marker comment per
     file so an error's line can still be traced to its module);
  2. rewrites app.html to load that one file where the first module was;
  3. rewrites sw.js so the precache lists the bundle instead of the modules.

Nothing is changed in git: the source tree keeps loading modules one by one,
so other work and the browser suite are untouched. `--check` builds to a
temporary directory and only reports what would change. `--root DIR` works on
a copy of the tree (the tests use this).

Preconditions checked (the script fails loudly rather than ship a page that
runs its scripts in a different order): every local script tag is `defer`,
no CDN `defer` script sits between the first and last local one, no local
module is listed twice, and every file exists.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
import tempfile
from pathlib import Path

BUNDLE_REL = "js/app.bundle.js"
SCRIPT_TAG = re.compile(r'<script\b([^>]*)\bsrc="([^"]+)"([^>]*)>\s*</script>', re.I)
LOCAL_SRC = re.compile(r"^js/[\w./-]+\.js$")
SW_JS_ENTRY = re.compile(r"^\s*'\./js/[^']+\.js',[^\n]*\n", re.M)


def find_scripts(html: str):
    """Yield (match, src, is_defer, is_local) for every <script src> tag."""
    for m in SCRIPT_TAG.finditer(html):
        attrs = (m.group(1) + " " + m.group(3)).lower()
        src = m.group(2)
        is_defer = re.search(r"\bdefer\b", attrs) is not None
        is_async = re.search(r"\basync\b", attrs) is not None
        yield m, src, is_defer and not is_async, LOCAL_SRC.match(src) is not None


def plan(root: Path):
    html_path = root / "app.html"
    html = html_path.read_text(encoding="utf-8")
    tags = list(find_scripts(html))
    local = [(m, src) for m, src, is_defer, is_local in tags if is_local]
    if not local:
        raise SystemExit("build_bundle: app.html has no local <script src=\"js/…\"> tags")
    problems = []
    for m, src, is_defer, is_local in tags:
        if is_local and not is_defer:
            problems.append(f"local script without defer (order would change): {src}")
    first, last = local[0][0].start(), local[-1][0].end()
    for m, src, is_defer, is_local in tags:
        if not is_local and is_defer and first < m.start() < last:
            problems.append(f"CDN defer script between local ones (bundle would run before it): {src}")
    seen = set()
    for _, src in local:
        if src in seen:
            problems.append(f"module listed twice: {src}")
        seen.add(src)
        if not (root / src).is_file():
            problems.append(f"missing on disk: {src}")
    if problems:
        raise SystemExit("build_bundle: refusing to bundle:\n  " + "\n  ".join(problems))
    return html, local


def bundle_text(root: Path, srcs) -> str:
    parts = [
        "// DigiPin app bundle — built by scripts/build_bundle.py at deploy time from\n"
        f"// {len(srcs)} modules, in app.html order. Edit the modules, not this file.\n"
    ]
    for src in srcs:
        body = (root / src).read_text(encoding="utf-8")
        parts.append(f"\n// ==== {src} ====\n{body.rstrip()}\n;\n")
    return "".join(parts)


def rewrite_html(html: str, local, bundle_rel: str, stamp: str) -> str:
    first_m = local[0][0]
    # No ?v= cache-buster: sw.js matches requests against its precache by full
    # URL, so a query string here would miss offline. Freshness comes from the
    # CACHE_NAME bump and the host's short max-age, as for the modules today.
    tag = f'<script defer src="{bundle_rel}"></script>  <!-- bundle v={stamp} -->'
    out = html[: first_m.start()] + tag + html[first_m.end():]
    # Remove the remaining local tags (and the line they sat on, when alone).
    for m, src in local[1:]:
        out = re.sub(r"[ \t]*" + re.escape(m.group(0)) + r"[ \t]*\n?", "", out, count=1)
    return out


def rewrite_sw(sw: str, bundle_rel: str) -> str:
    entries = SW_JS_ENTRY.findall(sw)
    if not entries:
        raise SystemExit("build_bundle: sw.js has no './js/…' precache entries")
    first = SW_JS_ENTRY.search(sw)
    indent = re.match(r"\s*", first.group(0)).group(0)
    out = SW_JS_ENTRY.sub("", sw)
    marker = f"{indent}'./{bundle_rel}',   // every js/ module, concatenated at deploy by scripts/build_bundle.py\n"
    # Put the bundle where the first module entry was: just before the closing of LOCAL_ASSETS.
    out = out.replace("];\n\n// Third-party libraries", marker + "];\n\n// Third-party libraries", 1)
    if marker not in out:
        raise SystemExit("build_bundle: could not place the bundle in sw.js LOCAL_ASSETS")
    return out


def build(root: Path, write: bool) -> dict:
    html, local = plan(root)
    srcs = [src for _, src in local]
    text = bundle_text(root, srcs)
    stamp = hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]
    new_html = rewrite_html(html, local, BUNDLE_REL, stamp)
    sw_path = root / "sw.js"
    new_sw = rewrite_sw(sw_path.read_text(encoding="utf-8"), BUNDLE_REL)
    if write:
        (root / BUNDLE_REL).write_text(text, encoding="utf-8")
        (root / "app.html").write_text(new_html, encoding="utf-8")
        sw_path.write_text(new_sw, encoding="utf-8")
    return {"modules": len(srcs), "bytes": len(text.encode("utf-8")), "stamp": stamp,
            "tags_before": len(local), "tags_after": len([1 for _, s, _, l in find_scripts(new_html) if l])}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=".", help="site root holding app.html, sw.js and js/ (default: cwd)")
    ap.add_argument("--check", action="store_true", help="build in a temporary copy and report; write nothing")
    args = ap.parse_args(argv)
    root = Path(args.root).resolve()
    if args.check:
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            shutil.copy(root / "app.html", t / "app.html")
            shutil.copy(root / "sw.js", t / "sw.js")
            shutil.copytree(root / "js", t / "js")
            info = build(t, write=True)
        print(f"build_bundle --check: {info['modules']} modules -> {BUNDLE_REL} ({info['bytes'] / 1e6:.2f} MB), "
              f"{info['tags_before']} script tags -> {info['tags_after']}; nothing written")
        return 0
    info = build(root, write=True)
    print(f"build_bundle: {info['modules']} modules -> {BUNDLE_REL} ({info['bytes'] / 1e6:.2f} MB, v={info['stamp']}); "
          f"app.html {info['tags_before']} local script tags -> {info['tags_after']}; sw.js precaches the bundle")
    return 0


if __name__ == "__main__":
    sys.exit(main())
