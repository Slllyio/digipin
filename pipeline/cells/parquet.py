"""Regenerate the GeoParquet copies of the cell store from its JSON files.

    python -m pipeline.cells.parquet                    # every catalog region
    python -m pipeline.cells.parquet --root _site/data/cells lst_monthly

The Parquet copies (what ``CellStore.sql()`` / DuckDB-WASM query) are not
kept in git: they duplicated the JSON and were over half of data/cells. The
JSON (``.json`` / quantised ``.json.gz``) is the source of truth; the deploy
workflow runs this before publishing, so every ``regions[].parquet`` path in
catalog.json exists on the site. Needs pyarrow.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline.cells import store
from pipeline.cells.schema import DatasetSpec, FieldSpec


def spec_from_catalog(entry: dict) -> DatasetSpec:
    """Enough of a DatasetSpec to write Parquet columns (keys + types)."""
    return DatasetSpec(id=entry["id"], title=entry.get("title", entry["id"]), level=entry["level"],
                       fields=[FieldSpec(f["key"], f.get("label", f["key"]), type=f.get("type", "number"))
                               for f in entry["fields"]])


def build(root, ids=None) -> list:
    """Write every catalog region's Parquet copy under ``root``; returns a summary."""
    root = Path(root)
    cat = json.loads((root / store.CATALOG).read_text())
    out = []
    for entry in cat.get("datasets", []):
        if ids and entry["id"] not in ids:
            continue
        spec = spec_from_catalog(entry)
        meta = {k: v for k, v in entry.items() if k != "regions"}
        for r in entry.get("regions", []):
            if not r.get("parquet"):
                continue
            table = store.read_region(root, r)
            store.write_parquet(root / r["parquet"], spec, table, meta=meta)
            out.append({"dataset": entry["id"], "region": r["name"], "cells": len(table)})
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Regenerate cell-store GeoParquet copies from the JSON.")
    p.add_argument("datasets", nargs="*", help="dataset ids (default: all)")
    p.add_argument("--root", default=str(Path(__file__).resolve().parents[2] / "data" / "cells"))
    a = p.parse_args(argv)
    done = build(a.root, set(a.datasets) or None)
    print(json.dumps({"parquet_files": len(done), "cells": sum(d["cells"] for d in done)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
