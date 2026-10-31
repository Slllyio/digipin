"""What exists and how it is wired: scraper modules, schemas, CI matrix, quality rows.

Read with ``ast`` and regexes rather than imports, so the steward never needs
the scrapers' runtime deps (requests / bs4) just to look at them.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCES_DIR = REPO_ROOT / "scrapers" / "sources"
SCHEMAS_DIR = SOURCES_DIR / "schemas"
REALTIME_DIR = REPO_ROOT / "data" / "realtime"
SCRAPE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "realtime-scrape.yml"
QUALITY_TEST = SOURCES_DIR / "tests" / "test_snapshot_quality.py"

_MATRIX_RE = re.compile(r"^\s*source:\s*\[([^\]]*)\]", re.M)
_QUALITY_ROW_RE = re.compile(r'^\s*\(\s*"([a-z0-9_]+)"\s*,', re.M)


@dataclass
class Source:
    id: str
    module_path: Path | None = None
    required_env: tuple[str, ...] = ()
    feed_url: str = ""
    has_schema: bool = False
    schema_path: Path | None = None
    in_matrix: bool = False
    in_quality: bool = False
    snapshot_path: Path | None = None
    notes: list[str] = field(default_factory=list)


def _module_constants(path: Path) -> dict:
    """Top-level literal assignments (SOURCE_ID, FEED_URL, REQUIRED_ENV) of a module."""
    out: dict = {}
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return out
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in ("SOURCE_ID", "FEED_URL", "REQUIRED_ENV"):
                try:
                    out[name] = ast.literal_eval(node.value)
                except ValueError:
                    pass
    return out


def matrix_sources(text: str) -> list[str]:
    """Source ids from the realtime-scrape.yml matrix line. Pure."""
    m = _MATRIX_RE.search(text or "")
    if not m:
        return []
    return [s.strip().strip("'\"") for s in m.group(1).split(",") if s.strip()]


def quality_rows(text: str) -> list[str]:
    """Source ids declared in test_snapshot_quality.py's SOURCES table. Pure."""
    block = (text or "").split("SOURCES = [", 1)
    if len(block) < 2:
        return []
    return _QUALITY_ROW_RE.findall(block[1].split("\n]", 1)[0])


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def discover(root: Path = REPO_ROOT) -> dict[str, Source]:
    """Every source known to any of: modules, schemas, CI matrix, quality table, data dir."""
    sources_dir = root / "scrapers" / "sources"
    schemas_dir = sources_dir / "schemas"
    realtime_dir = root / "data" / "realtime"
    out: dict[str, Source] = {}

    def get(sid: str) -> Source:
        return out.setdefault(sid, Source(id=sid))

    for path in sorted(sources_dir.glob("*.py")):
        if path.name.startswith("_"):
            continue
        consts = _module_constants(path)
        src = get(str(consts.get("SOURCE_ID") or path.stem))
        src.module_path = path
        env = consts.get("REQUIRED_ENV") or ()
        src.required_env = tuple(env) if isinstance(env, (tuple, list)) else ()
        src.feed_url = str(consts.get("FEED_URL") or "")

    for path in sorted(schemas_dir.glob("*.schema.json")):
        src = get(path.name[: -len(".schema.json")])
        src.has_schema = True
        src.schema_path = path

    for sid in matrix_sources(_read(root / ".github" / "workflows" / "realtime-scrape.yml")):
        get(sid).in_matrix = True

    for sid in quality_rows(_read(sources_dir / "tests" / "test_snapshot_quality.py")):
        get(sid).in_quality = True

    if realtime_dir.is_dir():
        for d in sorted(p for p in realtime_dir.iterdir() if p.is_dir()):
            snap = d / "latest.json"
            if snap.is_file():
                get(d.name).snapshot_path = snap

    return out
