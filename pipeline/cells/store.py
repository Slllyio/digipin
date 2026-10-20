"""Write (and read back) the per-DIGIPIN-cell data store.

Layout under the store root (default ``data/cells/``)::

    catalog.json                     layer registry (DatasetSpec + regions)
    <dataset>/<region>.json          columnar JSON — the browser's default read
    <dataset>/<region>.parquet       GeoParquet 1.1 — DuckDB(-WASM), QGIS, pandas

Both files hold the same table: one row per DIGIPIN cell at the dataset's level,
keyed by the dash-less code. Rows exist only for cells that received data
(sparse), sorted by code so neighbouring cells sit together.

The binning core (``bin_records``) is pure stdlib so it is unit-tested without
pyarrow; only ``write_parquet`` needs pyarrow (imported lazily).
"""
from __future__ import annotations

import json
import math
import os
import struct
from collections import Counter
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from pipeline._lib import digipin
from pipeline.cells.schema import SCHEMA_VERSION, DatasetSpec, FieldSpec, validate

CATALOG = "catalog.json"
# Regions above this many cells are split into per-prefix shards so the browser
# fetches only the part it needs (a clicked cell, a viewport).
SHARD_THRESHOLD = 8192
_JSON_DECIMALS = 4


@dataclass
class CellTable:
    """A dataset's rows: ``codes[i]`` is the cell, ``columns[key][i]`` its value."""
    level: int
    codes: list
    columns: dict

    def __len__(self) -> int:
        return len(self.codes)

    def row(self, code: str) -> Optional[dict]:
        code = code.replace("-", "").upper()[: self.level]
        try:
            i = self.codes.index(code)
        except ValueError:
            return None
        return {k: v[i] for k, v in self.columns.items()}


# ── cell addressing ─────────────────────────────────────────────────────────

def cell_code(level: int, lat: Optional[float] = None, lng: Optional[float] = None,
              code: Optional[str] = None) -> Optional[str]:
    """Dash-less DIGIPIN code at ``level`` for a point or an existing code.

    An existing code (any length >= level) is truncated — DIGIPIN is a strict
    quadtree, so a code's prefix *is* its parent cell. Returns None for points
    outside India or codes shorter than ``level``.
    """
    if code:
        c = str(code).replace("-", "").strip().upper()
        return c[:level] if len(c) >= level else None
    if lat is None or lng is None:
        return None
    try:
        return digipin.encode(float(lat), float(lng)).replace("-", "")[:level]
    except (ValueError, TypeError):
        return None


def cell_bounds(code: str) -> dict:
    """{south, north, west, east} of a (partial) DIGIPIN code."""
    return digipin.decode_partial(code)["bounds"]


# ── aggregation ─────────────────────────────────────────────────────────────

class _Acc:
    """Per-cell, per-field accumulator implementing every schema agg."""
    __slots__ = ("agg", "n", "total", "lo", "hi", "counts", "first", "anyv")

    def __init__(self, agg: str):
        self.agg = agg
        self.n = 0
        self.total = 0.0
        self.lo = math.inf
        self.hi = -math.inf
        self.counts = Counter()
        self.first = None
        self.anyv = False

    def add(self, v) -> None:
        if self.agg == "count":
            self.n += 1
            return
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return
        self.n += 1
        if self.first is None:
            self.first = v
        if self.agg == "mode":
            self.counts[v] += 1
        elif self.agg == "any":
            self.anyv = self.anyv or bool(v)
        elif self.agg in ("min", "max") and isinstance(v, str):
            # Ordinal categories (e.g. LOS "A".."F"): lexicographic extreme.
            self.lo = v if self.lo == math.inf or v < self.lo else self.lo
            self.hi = v if self.hi == -math.inf or v > self.hi else self.hi
        elif self.agg in ("mean", "sum", "min", "max"):
            x = float(v)
            self.total += x
            self.lo = min(self.lo, x)
            self.hi = max(self.hi, x)

    def value(self):
        if self.agg == "count":
            return self.n
        if self.n == 0:
            return None
        if self.agg == "mean":
            return self.total / self.n
        if self.agg == "sum":
            return self.total
        if self.agg == "min":
            return self.lo
        if self.agg == "max":
            return self.hi
        if self.agg == "any":
            return self.anyv
        if self.agg == "mode":
            # Deterministic tie-break: highest count, then smallest value.
            return sorted(self.counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[0][0]
        return self.first


def bin_records(records: Iterable[dict], level: int, fields: list) -> CellTable:
    """Aggregate point/grid records into DIGIPIN cells at ``level``.

    Each record is a dict with either ``digipin`` (any code length >= level) or
    ``lat`` + ``lng``, plus one entry per field key. Records outside India or
    with no location are skipped. Cells where every field is None are dropped.
    """
    accs: dict[str, list] = {}
    for rec in records:
        code = cell_code(level, rec.get("lat"), rec.get("lng"), rec.get("digipin"))
        if code is None:
            continue
        row = accs.get(code)
        if row is None:
            row = accs[code] = [_Acc(f.agg) for f in fields]
        for acc, f in zip(row, fields):
            acc.add(rec.get(f.key))

    codes, cols = [], {f.key: [] for f in fields}
    for code in sorted(accs):
        vals = [a.value() for a in accs[code]]
        if all(v is None for v in vals):
            continue
        codes.append(code)
        for f, v in zip(fields, vals):
            cols[f.key].append(_coerce(f, v))
    return CellTable(level=level, codes=codes, columns=cols)


def _coerce(f: FieldSpec, v):
    if v is None:
        return None
    if f.type == "boolean":
        return bool(v)
    if f.type == "category":
        return str(v)
    x = float(v)
    if math.isnan(x) or math.isinf(x):
        return None
    return int(x) if x.is_integer() and f.agg in ("count", "sum", "min", "max", "first") else x


# ── domains (legend extents) ────────────────────────────────────────────────

def data_domain(f: FieldSpec, values: list):
    """[min, max] for numbers, sorted category list for categories, None otherwise."""
    present = [v for v in values if v is not None]
    if not present:
        return None
    if f.type == "number":
        return [min(present), max(present)]
    if f.type == "category":
        return sorted({str(v) for v in present})
    return None


def resolved_spec(spec: DatasetSpec, table: CellTable) -> DatasetSpec:
    """Copy of ``spec`` with data-derived domains filled in where none was given."""
    fields = []
    for f in spec.fields:
        if f.domain is None:
            f = replace(f, domain=data_domain(f, table.columns.get(f.key, [])))
        fields.append(f)
    return replace(spec, fields=fields)


# ── writers ─────────────────────────────────────────────────────────────────

def _round(v):
    if isinstance(v, float):
        return round(v, _JSON_DECIMALS)
    return v


def write_json(path: Path, spec: DatasetSpec, region: str, table: CellTable) -> None:
    """Columnar JSON: {version, dataset, region, level, fields, cells, columns}."""
    keys = spec.field_keys()
    doc = {
        "version": SCHEMA_VERSION,
        "dataset": spec.id,
        "region": region,
        "level": table.level,
        "fields": keys,
        "cells": table.codes,
        "columns": {k: [_round(v) for v in table.columns[k]] for k in keys},
    }
    _atomic_write(path, json.dumps(doc, separators=(",", ":")))


def _polygon_wkb(b: dict) -> bytes:
    """Little-endian WKB Polygon for a cell rectangle (lng/lat, CCW exterior)."""
    ring = [(b["west"], b["south"]), (b["east"], b["south"]), (b["east"], b["north"]),
            (b["west"], b["north"]), (b["west"], b["south"])]
    out = struct.pack("<BIII", 1, 3, 1, len(ring))
    for x, y in ring:
        out += struct.pack("<dd", x, y)
    return out


def write_parquet(path: Path, spec: DatasetSpec, table: CellTable) -> None:
    """GeoParquet 1.1: digipin/level/lat/lng + bbox covering + WKB geometry + fields."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    bounds = [cell_bounds(c) for c in table.codes]
    arrays = {
        "digipin": pa.array(table.codes, pa.string()),
        "level": pa.array([table.level] * len(table), pa.int8()),
        "lat": pa.array([(b["south"] + b["north"]) / 2 for b in bounds], pa.float64()),
        "lng": pa.array([(b["west"] + b["east"]) / 2 for b in bounds], pa.float64()),
    }
    ptype = {"number": pa.float64(), "category": pa.string(), "boolean": pa.bool_()}
    for f in spec.fields:
        vals = table.columns[f.key]
        if f.type == "number":
            vals = [None if v is None else float(v) for v in vals]
        arrays[f.key] = pa.array(vals, ptype[f.type])
    arrays["bbox"] = pa.array(
        [{"xmin": b["west"], "ymin": b["south"], "xmax": b["east"], "ymax": b["north"]} for b in bounds],
        pa.struct([("xmin", pa.float64()), ("ymin", pa.float64()),
                   ("xmax", pa.float64()), ("ymax", pa.float64())]))
    arrays["geometry"] = pa.array([_polygon_wkb(b) for b in bounds], pa.binary())

    extent = _extent(bounds)
    geo = {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {"geometry": {
            "encoding": "WKB",
            "geometry_types": ["Polygon"],
            "bbox": [extent["west"], extent["south"], extent["east"], extent["north"]] if extent else [],
            "covering": {"bbox": {"xmin": ["bbox", "xmin"], "ymin": ["bbox", "ymin"],
                                  "xmax": ["bbox", "xmax"], "ymax": ["bbox", "ymax"]}},
        }},
    }
    meta = {b"geo": json.dumps(geo).encode(),
            b"digipin_cells": json.dumps(spec.to_json()).encode()}
    t = pa.table(arrays).replace_schema_metadata(meta)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(t, tmp, compression="zstd")
    os.replace(tmp, path)


def _extent(bounds: list) -> Optional[dict]:
    if not bounds:
        return None
    return {"west": min(b["west"] for b in bounds), "south": min(b["south"] for b in bounds),
            "east": max(b["east"] for b in bounds), "north": max(b["north"] for b in bounds)}


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def _merge_domain(f: dict, old: Optional[dict]) -> None:
    """Widen a data-derived domain with the same field's domain in other regions."""
    if not old or "domain" not in old or "domain" not in f or f["domain"] is None:
        return
    a, b = f["domain"], old["domain"]
    if f["type"] == "number" and len(a) == 2 and len(b) == 2:
        f["domain"] = [min(a[0], b[0]), max(a[1], b[1])]
    elif f["type"] == "category":
        f["domain"] = sorted(set(a) | set(b))


def shard_prefix_len(level: int, cells: int) -> Optional[int]:
    """Auto shard key length: None (one file) for small regions, else
    ``level - 3`` so each shard spans at most 4**3 x 4**3 = 4,096 cells."""
    if cells <= SHARD_THRESHOLD or level <= 3:
        return None
    return max(1, level - 3)


def shard_table(table: CellTable, prefix_len: int) -> dict:
    """{prefix: CellTable} splitting ``table`` by code prefix (order preserved)."""
    out: dict[str, CellTable] = {}
    for i, code in enumerate(table.codes):
        key = code[:prefix_len]
        t = out.get(key)
        if t is None:
            t = out[key] = CellTable(level=table.level, codes=[], columns={k: [] for k in table.columns})
        t.codes.append(code)
        for k, col in table.columns.items():
            t.columns[k].append(col[i])
    return out


def update_catalog(root: Path, spec: DatasetSpec, region: str, table: CellTable,
                   has_parquet: bool, explicit_domains: set,
                   shards: Optional[dict] = None) -> dict:
    """Upsert this dataset/region into catalog.json; returns the dataset entry."""
    path = root / CATALOG
    try:
        cat = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        cat = {}
    datasets = [d for d in cat.get("datasets", []) if isinstance(d, dict)]
    old = next((d for d in datasets if d.get("id") == spec.id), None)

    entry = spec.to_json()
    if old:
        old_fields = {f["key"]: f for f in old.get("fields", [])}
        for f in entry["fields"]:
            if f["key"] not in explicit_domains:
                _merge_domain(f, old_fields.get(f["key"]))

    extent = _extent([cell_bounds(c) for c in table.codes])
    reg = {
        "name": region,
        "cells": len(table),
        "bbox": extent,
        "json": f"{spec.id}/{region}/{{prefix}}.json" if shards else f"{spec.id}/{region}.json",
        "parquet": f"{spec.id}/{region}.parquet" if has_parquet else None,
    }
    if shards:
        reg["shards"] = shards
    others = [r for r in (old or {}).get("regions", []) if r.get("name") != region]
    entry["regions"] = sorted(others + [reg], key=lambda r: r["name"])

    datasets = [d for d in datasets if d.get("id") != spec.id] + [entry]
    cat = {
        "version": SCHEMA_VERSION,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "datasets": sorted(datasets, key=lambda d: d["id"]),
    }
    _atomic_write(path, json.dumps(cat, indent=2) + "\n")
    return entry


def write_dataset(root, spec: DatasetSpec, region: str, table: CellTable,
                  parquet: bool = True, shard: object = "auto") -> dict:
    """Validate, then write JSON (+ GeoParquet) and register in the catalog.

    ``parquet=True`` requires pyarrow; pass False for a JSON-only store.
    ``shard``: "auto" (split big regions, see ``shard_prefix_len``), None (one
    file) or an int prefix length. Sharded JSON goes to
    ``<id>/<region>/<prefix>.json``; the GeoParquet copy is always one file.
    Returns a small summary dict.
    """
    validate(spec)
    if table.level != spec.level:
        raise ValueError(f"table level {table.level} != spec level {spec.level}")
    root = Path(root)
    explicit = {f.key for f in spec.fields if f.domain is not None}
    spec = resolved_spec(spec, table)
    plen = shard_prefix_len(spec.level, len(table)) if shard == "auto" else shard
    single = root / spec.id / f"{region}.json"
    shard_dir = root / spec.id / region
    # Clear the other layout's files so a re-run can't leave stale data behind.
    for old in (shard_dir.glob("*.json") if shard_dir.is_dir() else []):
        old.unlink()
    shards = None
    if plen:
        if single.exists():
            single.unlink()
        parts = shard_table(table, plen)
        for key, part in parts.items():
            write_json(shard_dir / f"{key}.json", spec, region, part)
        shards = {"prefixLen": plen, "keys": sorted(parts)}
    else:
        write_json(single, spec, region, table)
    if parquet:
        write_parquet(root / spec.id / f"{region}.parquet", spec, table)
    update_catalog(root, spec, region, table, parquet, explicit, shards=shards)
    return {"dataset": spec.id, "region": region, "level": spec.level,
            "cells": len(table), "fields": len(spec.fields), "parquet": parquet,
            "shards": len(shards["keys"]) if shards else 0}


def read_json(path) -> CellTable:
    """Read a columnar JSON file back into a CellTable."""
    doc = json.loads(Path(path).read_text())
    return CellTable(level=doc["level"], codes=doc["cells"], columns=doc["columns"])


def read_region(root, region_entry: dict) -> CellTable:
    """Read a catalog region (sharded or not) back into one CellTable."""
    root = Path(root)
    sh = region_entry.get("shards")
    paths = ([root / region_entry["json"].replace("{prefix}", k) for k in sh["keys"]]
             if sh else [root / region_entry["json"]])
    tables = [read_json(p) for p in paths]
    out = CellTable(level=tables[0].level, codes=[], columns={k: [] for k in tables[0].columns})
    for t in tables:
        out.codes.extend(t.codes)
        for k in out.columns:
            out.columns[k].extend(t.columns[k])
    return out
