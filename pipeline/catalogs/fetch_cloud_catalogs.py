"""Index the big cloud data catalogs for the open-data finder.

Qiusheng Wu's opengeos/geospatial-data-catalogs (MIT) rebuilds flat TSVs of
the Google Earth Engine, Microsoft Planetary Computer, NASA Earthdata (CMR),
Copernicus Climate / Emergency data stores and AWS Open Data registries each
day. This script keeps the rows whose bbox reaches India, drops deprecated
ones, and writes them in the same
entry shape as the hand-curated ``data/open-data/catalog.json`` so
``OpenDataFinder`` can search both:

    data/open-data/cloud_catalogs.json
        {"version": 1, "generated": ..., "source": ..., "datasets": [entry, ...]}

NASA CMR lists ~18k collections, most of them global swaths, so only two kinds
are kept: collections mostly over India (or named for it, e.g. ISRO INSAT-3D),
and global gridded (L3/L4) cloud-hosted products on urban themes (rain, heat,
air, flood, land cover, night lights...), one per title across versions. AWS
Open Data has no bbox, so only entries that name India are kept.

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
import ast
import csv
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional
from urllib.request import Request, urlopen

BASE = "https://raw.githubusercontent.com/opengeos/geospatial-data-catalogs/master/"
SOURCES = {
    "gee": BASE + "gee_catalog.tsv",
    "pc": BASE + "pc_catalog.tsv",
    "cmr": BASE + "nasa_cmr_catalog.tsv",
    "cds": BASE + "copernicus_climate.tsv",
    "ewds": BASE + "copernicus_emergency.tsv",
    "aws": BASE + "aws_geo_datasets.tsv",
}
OUT = Path("data/open-data/cloud_catalogs.json")
INDIA_BBOX = (68.0, 6.5, 97.5, 35.5)
MAX_TAGS = 10
# Upstream bboxes are sometimes global for a national product (California
# AirView, USGS 3DEP, CORINE). Rows whose title or id names a place India is
# not in are dropped rather than trusted.
OFF_INDIA = re.compile(
    r"\b(california|canada|canadian|europe|european|corine|epfd|usa|conus|united states|alaska|hawaii|"
    r"us drought|africa|african|brazil|australia|mexico|germany|france|england|japan|china|goes|3dep|nlcd|naip|"
    r"soviet|thailand|antarctic|arctic|greenland|efas|us climate reference)\b",
    re.I)
# NASA CMR filters (see module docstring).
CMR_INDIA = re.compile(r"\b(india|indian subcontinent|south asia|isro|insat|oceansat|resourcesat|cartosat|ganga|ganges|"
                       r"himalaya|brahmaputra|indo-gangetic)\b", re.I)
CMR_THEME = re.compile(r"\b(urban|land cover|land use|impervious|built|precipitation|rainfall|imerg|land surface temperature|"
                       r"air temperature|aerosol|air quality|no2|nitrogen dioxide|pm2\.?5|flood|inundation|elevation|dem|"
                       r"night ?lights?|black marble|population|soil moisture|evapotranspiration|ndvi|vegetation indices|"
                       r"groundwater|surface water|burned area|thermal anomalies)\b", re.I)
CMR_GRIDDED = re.compile(r"\b(l3|l4|level[- ]?[34]|grid|gridded|mosaic|monthly|daily|yearly|annual|8-day|16-day)\b", re.I)
CMR_SWATH = re.compile(r"\b(swath|nrt|near real[- ]time|l1|l2|level[- ]?[12]|radiances?|granules?|calibration|airborne|cruise)\b", re.I)
CMR_CLOUD = re.compile(r"CLOUD|GES_DISC|LAADS|ORNL", re.I)
INDIA_REGION = re.compile(r"\bIndia\b")

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


def off_india(title: str, ident: str) -> bool:
    return bool(OFF_INDIA.search(f"{title} {re.sub(r'[/_-]', ' ', ident)}"))


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
        if off_india(r.get("title", ""), r["id"]):
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
        if off_india(r.get("title", ""), r["id"]):
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


def overlap_share(bbox: tuple, region: tuple = INDIA_BBOX) -> float:
    """Share of `bbox`'s area that lies inside `region` (0..1)."""
    w, s, e, n = bbox
    iw = max(0.0, min(e, region[2]) - max(w, region[0]))
    ih = max(0.0, min(n, region[3]) - max(s, region[1]))
    area = max((e - w) * (n - s), 1e-9)
    return (iw * ih) / area


def _version_stem(title: str) -> str:
    """Title without version numbers, so V006 and V061 of one product collapse."""
    t = re.sub(r"\b(version|v)\s?\d+(\.\d+)*\b", "", title, flags=re.I)
    t = re.sub(r"\(?\b[A-Z0-9_]{6,}\b\)?", "", t)
    return re.sub(r"\s+", " ", t).strip().lower()


def cmr_entries(rows: Iterable[dict]) -> Iterable[dict]:
    seen = set()
    for r in rows:
        bbox = parse_bbox(r.get("bbox", ""))
        title, ident, cat = r.get("title", ""), r.get("id", ""), r.get("catalog", "")
        url = r.get("url", "")
        if not bbox or not intersects(bbox) or not ident or not url.startswith("https://"):
            continue
        if off_india(title, ident):
            continue
        named = bool(CMR_INDIA.search(f"{title} {cat}"))
        local = (bbox[2] - bbox[0]) < 120 and overlap_share(bbox) >= 0.25
        gridded = (bbox[2] - bbox[0]) >= 300 and CMR_CLOUD.search(cat) and CMR_THEME.search(title) \
            and CMR_GRIDDED.search(title) and not CMR_SWATH.search(title)
        if not (named or local or gridded):
            continue
        stem = (_version_stem(title), cat)
        if stem in seen:
            continue
        seen.add(stem)
        m = re.search(r"/concepts/([A-Z0-9]+-[A-Z0-9_]+)", url)
        concept = m.group(1) if m else ident
        yield {
            "id": "cmr:" + concept,
            "title": title or ident,
            "publisher": "NASA Earthdata · " + re.sub(r"\s*STAC Catalog$", "", cat).strip(),
            "url": "https://search.earthdata.nasa.gov/search/granules?p=" + concept,
            "license": r.get("license") or "see dataset page",
            "coverage": coverage(bbox),
            "format": "NASA CMR collection (Earthdata login to download)",
            "years": _years(r.get("state_date", ""), r.get("end_date", "")),
            "tags": _tags(",".join(m.lower() for m in CMR_THEME.findall(title)), "nasa",
                          re.sub(r"\s*STAC Catalog$", "", cat).lower()),
            "platform": "NASA Earthdata",
            "access": url,
        }


def _literal(text: str):
    """The TSVs store STAC fields as Python reprs ("{'spatial': ...}")."""
    try:
        return ast.literal_eval(text) if text else None
    except (ValueError, SyntaxError):
        return None


def copernicus_entries(rows: Iterable[dict], store: str) -> Iterable[dict]:
    host = {"cds": "cds.climate.copernicus.eu", "ewds": "ewds.climate.copernicus.eu"}[store]
    name = {"cds": "Copernicus Climate Data Store", "ewds": "Copernicus Emergency (CEMS) Data Store"}[store]
    for r in rows:
        ident, title = r.get("id", ""), r.get("title", "")
        ext = _literal(r.get("extent", "")) or {}
        try:
            w, s, e, n = ext["spatial"]["bbox"][0]
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if e > 180:  # 0..360 longitudes
            w, e = (-180.0, 180.0) if (e - w) >= 300 else (w - 360 if w > 180 else w, e - 360 if e > 180 else e)
        bbox = parse_bbox(f"{w},{s},{e},{n}")
        if not ident or not bbox or not intersects(bbox) or off_india(title, ident):
            continue
        try:
            start, end = ext["temporal"]["interval"][0]
        except (KeyError, IndexError, TypeError, ValueError):
            start, end = "", ""
        kws = _literal(r.get("keywords", "")) or []
        yield {
            "id": f"{store}:{ident}",
            "title": title or ident,
            "publisher": name,
            "url": f"https://{host}/datasets/{ident}",
            "license": r.get("license") or "see dataset page",
            "coverage": coverage(bbox),
            "format": "Copernicus data store (free account to download)",
            "years": _years(start or "", end or ""),
            "tags": _tags(",".join(k.split(":")[-1] for k in kws if isinstance(k, str)), "copernicus"),
            "platform": "Copernicus",
            "access": f"https://{host}/api/catalogue/v1/collections/{ident}",
        }


def aws_entries(rows: Iterable[dict]) -> Iterable[dict]:
    seen = set()
    for r in rows:
        name, desc = r.get("Name", ""), r.get("Description", "")
        if not INDIA_REGION.search(f"{name} {desc} {r.get('Tags', '')}") or name in seen:
            continue
        if str(r.get("ControlledAccess", "")).strip() or str(r.get("AccountRequired", "")).lower() == "true":
            continue
        seen.add(name)
        doc = r.get("Documentation", "")
        m = re.search(r"https://[^\s)\]']+", doc) or re.search(r"https://[^\s)\]']+", r.get("Explore", ""))
        arn = r.get("ARN", "")
        lic = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", r.get("License", "")).strip()
        yield {
            "id": "aws:" + (arn.split(":::")[-1] if ":::" in arn else name),
            "title": name,
            "publisher": re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", r.get("ManagedBy", "")).strip() or "AWS Open Data",
            "url": m.group(0) if m else "https://registry.opendata.aws/",
            "license": lic[:80] or "see dataset page",
            "coverage": "India",
            "format": r.get("Type") or "S3 bucket",
            "years": "",
            "tags": _tags(r.get("Tags", "").strip("[]").replace("'", "")),
            "platform": "AWS Open Data",
            "access": arn.replace("arn:aws:s3:::", "s3://") if arn.startswith("arn:aws:s3:::") else arn,
        }


def read_tsv(text: str) -> list:
    csv.field_size_limit(sys.maxsize)
    return list(csv.DictReader(io.StringIO(text), delimiter="\t"))


def build(tsvs: dict) -> dict:
    """{'gee': tsv_text, 'pc': ..., 'cmr': ..., 'cds': ..., 'ewds': ..., 'aws': ...} → catalog document (no I/O)."""
    datasets, seen = [], set()
    rows = lambda k: read_tsv(tsvs.get(k, ""))  # noqa: E731
    for entry in [*gee_entries(rows("gee")), *pc_entries(rows("pc")), *cmr_entries(rows("cmr")),
                  *copernicus_entries(rows("cds"), "cds"), *copernicus_entries(rows("ewds"), "ewds"),
                  *aws_entries(rows("aws"))]:
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
