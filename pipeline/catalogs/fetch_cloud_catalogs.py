"""Index the Earth Engine and Planetary Computer catalogs for the open-data finder.

Qiusheng Wu's opengeos/geospatial-data-catalogs (MIT) rebuilds a flat TSV of
every dataset on Google Earth Engine and Microsoft Planetary Computer each day,
with a bounding box, licence and keywords per row. This script keeps the rows
whose bbox reaches India, drops deprecated ones, and writes them in the same
entry shape as the hand-curated ``data/open-data/catalog.json`` so
``OpenDataFinder`` can search both:

    data/open-data/cloud_catalogs.json
        {"version": 1, "generated": ..., "source": ..., "datasets": [entry, ...]}

An entry carries the finder's card fields (id, title, publisher, url, license,
coverage, format, tags) plus ``platform`` and ``access`` (the ``ee.Image(...)``
snippet or the STAC collection URL), which is what a pipeline needs to pull the
data into a DIGIPIN cell dataset (see ``pipeline/cells``).

Usage:
    python pipeline/catalogs/fetch_cloud_catalogs.py
    python pipeline/catalogs/fetch_cloud_catalogs.py --out /tmp/cloud.json
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional
from urllib.request import Request, urlopen

BASE = "https://raw.githubusercontent.com/opengeos/geospatial-data-catalogs/master/"
SOURCES = {
    "gee": BASE + "gee_catalog.tsv",
    "pc": BASE + "pc_catalog.tsv",
}
OUT = Path("data/open-data/cloud_catalogs.json")
INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
MAX_TAGS = 10

_EE_TYPES = {"image": "Raster (EE Image)", "image_collection": "Raster time series (EE ImageCollection)",
             "table": "Vector (EE FeatureCollection)", "table_collection": "Vector (EE FeatureCollection)"}


def parse_bbox(text: str) -> Optional[tuple]:
    """'w, s, e, n' → floats, or None when the cell is empty or malformed."""
    try:
        parts = [float(p) for p in str(text).split(",")]
    except ValueError:
        return None
    if len(parts) != 4:
        return None
    w, s, e, n = parts
    return None if w > e or s > n else (w, s, e, n)


def intersects(a: tuple, b: tuple = INDIA_BBOX) -> bool:
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def coverage(bbox: tuple) -> str:
    w, s, e, n = bbox
    if (e - w) >= 300 and (n - s) >= 100:
        return "Global"
    if (e - w) >= 120:
        return "Multi-continental (covers India)"
    return "Regional (bbox reaches India: %.1f, %.1f, %.1f, %.1f)" % bbox


def _years(start: str, end: str) -> str:
    a, b = (start or "")[:4], (end or "")[:4]
    if a and b and a != b:
        return f"{a}–{b}"
    return a or b


def _tags(*fields: str) -> list:
    out = []
    for f in fields:
        for t in str(f or "").replace(";", ",").split(","):
            t = t.strip().lower()
            if t and t not in out:
                out.append(t)
    return out[:MAX_TAGS]


def gee_entries(rows: Iterable[dict]) -> Iterable[dict]:
    for r in rows:
        if str(r.get("deprecated", "")).lower() == "true":
            continue
        bbox = parse_bbox(r.get("bbox", ""))
        if not bbox or not intersects(bbox) or not r.get("id") or not r.get("url", "").startswith("https://"):
            continue
        yield {
            "id": "ee:" + r["id"],
            "title": r.get("title") or r["id"],
            "publisher": (r.get("provider") or "Google Earth Engine").strip(),
            "url": r["url"],
            "license": r.get("license") or "see dataset page",
            "coverage": coverage(bbox),
            "format": _EE_TYPES.get(r.get("type", ""), "Earth Engine asset"),
            "years": _years(r.get("state_date", ""), r.get("end_date", "")),
            "tags": _tags(r.get("category", ""), r.get("keywords", "")),
            "platform": "Earth Engine",
            "access": r.get("snippet") or r["id"],
        }


def pc_entries(rows: Iterable[dict]) -> Iterable[dict]:
    for r in rows:
        bbox = parse_bbox(r.get("bbox", ""))
        link = r.get("link", "")
        if not bbox or not intersects(bbox) or not r.get("id") or not link.startswith("https://"):
            continue
        yield {
            "id": "pc:" + r["id"],
            "title": r.get("title") or r["id"],
            "publisher": (r.get("providers") or "Microsoft Planetary Computer").strip(),
            "url": "https://planetarycomputer.microsoft.com/dataset/" + r["id"],
            "license": r.get("license") or "see dataset page",
            "coverage": coverage(bbox),
            "format": "STAC collection (COG / Zarr / GeoParquet)",
            "years": _years(r.get("start_date", ""), r.get("end_date", "")),
            "tags": _tags(r.get("keywords", "")),
            "platform": "Planetary Computer",
            "access": link,
        }


def read_tsv(text: str) -> list:
    return list(csv.DictReader(io.StringIO(text), delimiter="\t"))


def build(tsvs: dict) -> dict:
    """{'gee': tsv_text, 'pc': tsv_text} → catalog document (no I/O)."""
    datasets, seen = [], set()
    for entry in [*gee_entries(read_tsv(tsvs.get("gee", ""))), *pc_entries(read_tsv(tsvs.get("pc", "")))]:
        if entry["id"] in seen:
            continue
        seen.add(entry["id"])
        datasets.append(entry)
    datasets.sort(key=lambda d: (d["platform"], d["title"].lower()))
    return {
        "version": 1,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "https://github.com/opengeos/geospatial-data-catalogs (MIT, Qiusheng Wu)",
        "filter": {"bboxIntersects": list(INDIA_BBOX), "deprecated": False},
        "datasets": datasets,
    }


def _fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": "digipin-pipeline (+https://github.com/Slllyio/digipin)"})
    with urlopen(req, timeout=60) as res:
        return res.read().decode("utf-8")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    doc = build({k: _fetch(u) for k, u in SOURCES.items()})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    by = {}
    for d in doc["datasets"]:
        by[d["platform"]] = by.get(d["platform"], 0) + 1
    print(f"wrote {args.out}: {len(doc['datasets'])} datasets {by}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
