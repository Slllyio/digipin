"""Scaffold a new scraper source that already meets the repo's conventions.

Writes ``scrapers/sources/<id>.py`` (SOURCE_ID, FEED_URL, a Record dataclass
with ``csv_fields()``, ``fetch(client)``, ``key_for()``), a matching
``schemas/<id>.schema.json``, and registers the source in the
realtime-scrape.yml matrix and the snapshot-quality SOURCES table. The fetch
body is a working starting point for the chosen format; field mapping is left
for a human (or the model) to finish before the first scrape.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import inventory

FORMATS = ("json", "geojson", "rss")
_ID_RE = re.compile(r"^[a-z][a-z0-9_]{2,40}$")

_FETCH = {
    "json": '''    body = client.get(FEED_URL)
    if body is None:
        return []
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as e:
        log.error("{sid} JSON parse error: %s", e)
        return []
    items = payload if isinstance(payload, list) else (payload.get("results") or payload.get("data") or [])
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        rid = str(item.get("id") or "").strip()
        if not rid:
            continue
        out.append(Record(
            id=rid,
            title=str(item.get("title") or item.get("name") or ""),
            published_utc=str(item.get("published") or item.get("updated") or ""),
            latitude=_num(item.get("lat") or item.get("latitude")),
            longitude=_num(item.get("lon") or item.get("lng") or item.get("longitude")),
        ))
    return out
''',
    "geojson": '''    body = client.get(FEED_URL)
    if body is None:
        return []
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as e:
        log.error("{sid} GeoJSON parse error: %s", e)
        return []
    out = []
    for feat in payload.get("features") or []:
        props = feat.get("properties") or {{}}
        coords = (feat.get("geometry") or {{}}).get("coordinates") or [None, None]
        rid = str(feat.get("id") or props.get("id") or "").strip()
        if not rid:
            continue
        out.append(Record(
            id=rid,
            title=str(props.get("title") or props.get("name") or ""),
            published_utc=str(props.get("time") or props.get("updated") or ""),
            latitude=_num(coords[1] if len(coords) > 1 else None),
            longitude=_num(coords[0]),
        ))
    return out
''',
    "rss": '''    body = client.get(FEED_URL)
    if body is None:
        return []
    from defusedxml import ElementTree as ET  # untrusted XML

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        log.error("{sid} RSS parse error: %s", e)
        return []
    out = []
    for item in root.iter("item"):
        rid = (item.findtext("guid") or item.findtext("link") or "").strip()
        if not rid:
            continue
        out.append(Record(
            id=rid,
            title=(item.findtext("title") or "").strip(),
            published_utc=(item.findtext("pubDate") or "").strip(),
            latitude=None,
            longitude=None,
        ))
    return out
''',
}

_MODULE = '''"""{title}

Feed: {url}
Format: {fmt}

Scaffolded by `python -m pipeline.steward scaffold`. Before the first CI run:
  - check the field mapping in fetch() against a real response
  - tighten scrapers/sources/schemas/{sid}.schema.json (ranges, enums)
  - add the source to scrapers/README.md
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.{sid}")

SOURCE_ID = "{sid}"
FEED_URL = "{url}"
{env_line}

@dataclass
class Record:
    id: str
    title: str
    published_utc: str
    latitude: float | None
    longitude: float | None

    @staticmethod
    def csv_fields() -> list[str]:
        return ["id", "title", "published_utc", "latitude", "longitude"]


# The CLI looks for `Alert.csv_fields()` when writing the CSV mirror.
Alert = Record


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch(client: PoliteClient) -> list[Record]:
{fetch}

def key_for(record: Record) -> str:
    return record.id
'''


def _schema(sid: str, title: str) -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://github.com/Slllyio/digipin/scrapers/sources/schemas/{sid}.schema.json",
        "title": f"{title} snapshot",
        "description": f"Contract for data/realtime/{sid}/latest.json.",
        "type": "object",
        "required": ["count", "records"],
        "properties": {
            "generated_at_iso": {"type": "string"},
            "count": {"type": "integer", "minimum": 0},
            "records": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["id", "title"],
                    "properties": {
                        "id": {"type": "string", "minLength": 1},
                        "title": {"type": "string"},
                        "published_utc": {"type": "string"},
                        "latitude": {"type": ["number", "null"], "minimum": -90, "maximum": 90},
                        "longitude": {"type": ["number", "null"], "minimum": -180, "maximum": 180},
                    },
                },
            },
        },
    }


def render_module(sid: str, url: str, fmt: str, title: str, required_env=()) -> str:
    """Source module text. Pure."""
    env_line = f"REQUIRED_ENV = {tuple(required_env)!r}\n" if required_env else ""
    return _MODULE.format(title=title, url=url, fmt=fmt, sid=sid, env_line=env_line,
                          fetch=_FETCH[fmt].format(sid=sid).rstrip("\n") + "\n")


def add_to_matrix(text: str, sid: str) -> str:
    """Append ``sid`` to the realtime-scrape.yml matrix list (idempotent). Pure."""
    if sid in inventory.matrix_sources(text):
        return text
    return re.sub(r"(^\s*source:\s*\[)([^\]]*)(\])",
                  lambda m: f"{m.group(1)}{m.group(2).rstrip()}, {sid}{m.group(3)}", text, count=1, flags=re.M)


def add_quality_row(text: str, sid: str) -> str:
    """Add a SOURCES row to test_snapshot_quality.py (idempotent). Pure."""
    if sid in inventory.quality_rows(text):
        return text
    row = f'    ("{sid}",' + " " * max(1, 18 - len(sid)) + '"id",   None),\n'
    marker = "    # NOTE: add more sources as schemas land."
    if marker in text:
        return text.replace(marker, row + marker, 1)
    head, sep, tail = text.partition("SOURCES = [\n")
    return head + sep + row + tail if sep else text


def scaffold(sid: str, url: str, fmt: str = "json", title: str = "", required_env=(),
             root: Path = inventory.REPO_ROOT, force: bool = False) -> list[Path]:
    """Write the module + schema and register the source. Returns the paths touched."""
    if not _ID_RE.match(sid):
        raise ValueError("source id must be lowercase snake_case, 3-41 chars, starting with a letter")
    if fmt not in FORMATS:
        raise ValueError(f"format must be one of {', '.join(FORMATS)}")
    if not url.startswith("https://"):
        raise ValueError("feed URL must be https://")
    title = title or sid.replace("_", " ").title()

    module = root / "scrapers" / "sources" / f"{sid}.py"
    schema = root / "scrapers" / "sources" / "schemas" / f"{sid}.schema.json"
    if not force and (module.exists() or schema.exists()):
        raise FileExistsError(f"{sid} already exists; pass force=True to overwrite")

    module.write_text(render_module(sid, url, fmt, title, required_env), encoding="utf-8")
    schema.write_text(json.dumps(_schema(sid, title), indent=2) + "\n", encoding="utf-8")
    touched = [module, schema]

    workflow = root / ".github" / "workflows" / "realtime-scrape.yml"
    if workflow.is_file():
        workflow.write_text(add_to_matrix(workflow.read_text(encoding="utf-8"), sid), encoding="utf-8")
        touched.append(workflow)
    quality = root / "scrapers" / "sources" / "tests" / "test_snapshot_quality.py"
    if quality.is_file():
        quality.write_text(add_quality_row(quality.read_text(encoding="utf-8"), sid), encoding="utf-8")
        touched.append(quality)
    return touched
