"""Ingest any CSV / GeoJSON into the cell store — "plot any dataset".

    python -m pipeline.cells.ingest hospitals.csv --id hospitals --title "Hospitals" --level 8
    python -m pipeline.cells.ingest wards.geojson --id wards --level 7 --region indore_pilot

Location comes from (first match wins):
  * a ``digipin`` / ``digipin_code`` / ``pin`` column (any code length >= level),
  * ``lat``/``latitude``/``y`` + ``lng``/``lon``/``long``/``longitude``/``x`` columns,
  * GeoJSON geometry (Point; other geometries use their vertex-bbox centre).

Every row adds to ``count``; numeric columns become ``mean`` fields, low-cardinality
text columns become ``mode`` category fields. ``--agg col=sum`` overrides.

The same inference runs in the browser (js/cell-ingest.js) for drag-and-drop,
so a file previewed in the app and committed via this CLI render identically.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Iterable

from pipeline.cells import store
from pipeline.cells.schema import AGGS, DatasetSpec, FieldSpec

LAT_KEYS = ("lat", "latitude", "y")
LNG_KEYS = ("lng", "lon", "long", "longitude", "x")
PIN_KEYS = ("digipin", "digipin_code", "pin")
MAX_CATEGORIES = 24


def slug(s: str) -> str:
    """snake_case field key from an arbitrary column name."""
    k = re.sub(r"[^a-z0-9]+", "_", str(s).strip().lower()).strip("_")
    if not k or not k[0].isalpha():
        k = "f_" + k
    return k[:64]


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).strip().replace(",", ""))
    except ValueError:
        return None


def _find(cols: Iterable[str], candidates) -> str | None:
    low = {c.lower().strip(): c for c in cols}
    return next((low[c] for c in candidates if c in low), None)


def _geom_center(geom: dict):
    """(lat, lng) for a Point, else the centre of the geometry's vertex bbox."""
    if not geom:
        return None
    if geom.get("type") == "Point":
        x, y = geom["coordinates"][:2]
        return y, x
    xs, ys = [], []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for sub in c or []:
                walk(sub)
    walk(geom.get("coordinates"))
    if not xs:
        return None
    return (min(ys) + max(ys)) / 2, (min(xs) + max(xs)) / 2


def read_rows(path: Path) -> list[dict]:
    """Uniform rows: {"lat","lng"} or {"digipin"} plus raw attribute columns."""
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() in (".geojson", ".json"):
        doc = json.loads(text)
        feats = doc.get("features", []) if doc.get("type") == "FeatureCollection" else [doc]
        rows = []
        for f in feats:
            props = dict(f.get("properties") or {})
            c = _geom_center(f.get("geometry"))
            if c:
                props["lat"], props["lng"] = c
            rows.append(props)
        return rows
    return list(csv.DictReader(text.splitlines()))


def infer_fields(rows: list[dict], aggs: dict | None = None) -> tuple[list, dict]:
    """(FieldSpecs, column-key -> source-column) inferred from attribute columns."""
    aggs = aggs or {}
    cols = list(dict.fromkeys(k for r in rows for k in r.keys()))
    loc = {_find(cols, LAT_KEYS), _find(cols, LNG_KEYS), _find(cols, PIN_KEYS)} - {None}
    fields = [FieldSpec("count", "Count", agg="count", unit="count", ramp="heat")]
    source = {}
    for col in cols:
        if col in loc:
            continue
        key = slug(col)
        if key in source or key in ("count", "digipin", "level", "lat", "lng", "geometry", "bbox"):
            continue
        vals = [r.get(col) for r in rows if r.get(col) not in (None, "")]
        if not vals:
            continue
        nums = [_num(v) for v in vals]
        if all(n is not None for n in nums):
            fields.append(FieldSpec(key, str(col), agg=aggs.get(key, "mean"), ramp="viridis"))
        elif len({str(v) for v in vals}) <= MAX_CATEGORIES:
            fields.append(FieldSpec(key, str(col), type="category", agg=aggs.get(key, "mode")))
        else:
            continue  # free text (names, ids) — not plottable
        source[key] = col
    return fields, source


def to_records(rows: list[dict], fields: list, source: dict) -> list[dict]:
    if not rows:
        return []
    cols = list(dict.fromkeys(k for r in rows for k in r.keys()))
    lat_c, lng_c, pin_c = _find(cols, LAT_KEYS), _find(cols, LNG_KEYS), _find(cols, PIN_KEYS)
    out = []
    for r in rows:
        rec = {}
        if pin_c and r.get(pin_c):
            rec["digipin"] = r[pin_c]
        elif lat_c and lng_c:
            rec["lat"], rec["lng"] = _num(r.get(lat_c)), _num(r.get(lng_c))
        for f in fields:
            if f.key == "count":
                continue
            v = r.get(source[f.key])
            rec[f.key] = _num(v) if f.type == "number" else (None if v in (None, "") else str(v))
        out.append(rec)
    return out


def ingest(path, dataset_id: str, title: str, level: int, region: str, out,
           aggs: dict | None = None, parquet: bool = True, description: str = "") -> dict:
    path = Path(path)
    rows = read_rows(path)
    fields, source = infer_fields(rows, aggs)
    table = store.bin_records(to_records(rows, fields, source), level, fields)
    spec = DatasetSpec(id=dataset_id, title=title, level=level, fields=fields,
                       description=description or f"Ingested from {path.name}",
                       source=path.name, group="Ingested data")
    return store.write_dataset(out, spec, region, table, parquet=parquet)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Bin a CSV/GeoJSON into DIGIPIN cells.")
    p.add_argument("path")
    p.add_argument("--id", required=True, help="dataset id (snake_case)")
    p.add_argument("--title")
    p.add_argument("--level", type=int, default=8, help="DIGIPIN level (7≈244 m, 8≈61 m)")
    p.add_argument("--region", default="indore_pilot", help="region tag for the output file")
    p.add_argument("--out", default="data/cells")
    p.add_argument("--agg", action="append", default=[], metavar="COL=AGG",
                   help=f"override a column's aggregation ({', '.join(AGGS)})")
    p.add_argument("--no-parquet", action="store_true")
    a = p.parse_args(argv)
    aggs = {}
    for item in a.agg:
        k, _, v = item.partition("=")
        aggs[slug(k)] = v
    summary = ingest(a.path, a.id, a.title or a.id.replace("_", " ").title(), a.level,
                     a.region, a.out, aggs=aggs, parquet=not a.no_parquet)
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
