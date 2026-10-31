"""Every field the cell store holds for one DIGIPIN, across all datasets.

The store is already a static, public data API: catalog.json lists every dataset and region, and each region is
a columnar JSON file (sharded by code prefix for big cities). This tool walks it for one code, so it doubles as a
worked example of reading the files directly (see docs/DATA_API.md).

    python -m pipeline.cells.lookup 39J-4M9-8PLC          # a full address: each dataset at its own level
    python -m pipeline.cells.lookup 39J4M98 --json
    python -m pipeline.cells.lookup --lat 28.61 --lng 77.21
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipeline.cells import store

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"


def _inside(b, lat, lng):
    return b["south"] <= lat <= b["north"] and b["west"] <= lng <= b["east"]


def lookup(code, root=CELLS):
    """{dataset id: {'title', 'level', 'code', 'values': {field: value}}} for every dataset with data at ``code``."""
    code = code.replace("-", "").upper()
    b = store.cell_bounds(code)
    lat, lng = (b["south"] + b["north"]) / 2, (b["west"] + b["east"]) / 2
    cat = json.loads((Path(root) / "catalog.json").read_text())
    out = {}
    for d in cat["datasets"]:
        level = d.get("level")
        if not level or level > len(code):
            continue
        key = code[:level]
        for r in d.get("regions") or []:
            if not r.get("bbox") or not _inside(r["bbox"], lat, lng):
                continue
            t = store.read_region(root, r)
            try:
                i = t.codes.index(key)
            except ValueError:
                continue
            vals = {}
            for f in d["fields"]:
                col = t.columns.get(f["key"])
                if col is not None and i < len(col) and col[i] is not None:
                    vals[f["key"]] = col[i]
            if vals:
                out[d["id"]] = {"title": d.get("title"), "level": level, "code": key, "region": r["name"], "values": vals}
            break
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("code", nargs="?")
    p.add_argument("--lat", type=float)
    p.add_argument("--lng", type=float)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    code = a.code or store.cell_code(10, a.lat, a.lng)
    if not code:
        p.error("give a DIGIPIN code or --lat/--lng inside India")
    res = lookup(code)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return 0
    for ds, x in res.items():
        print(f"{ds} (L{x['level']} {x['code']}, {x['region']}): " + ", ".join(f"{k}={v}" for k, v in x["values"].items()))
    print(f"{len(res)} datasets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
