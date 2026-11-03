"""Per-city coverage matrix of the cell store, as Markdown.

    python -m pipeline.cells.coverage                 # print the table
    python -m pipeline.cells.coverage --write         # refresh docs/CELL_STORE.md

Rows are the app's cities (pipeline/_lib/regions.py CITY_PILOTS), columns the
catalog's datasets; a cell shows the region's cell count, or "—" when the
dataset has nothing there. ``--write`` replaces the block between the
``coverage:start`` / ``coverage:end`` markers in docs/CELL_STORE.md.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO / "data" / "cells" / "catalog.json"
DOC = REPO / "docs" / "CELL_STORE.md"
START, END = "<!-- coverage:start -->", "<!-- coverage:end -->"


def matrix(catalog: dict, cities=CITY_PILOTS) -> str:
    ds = sorted(catalog.get("datasets", []), key=lambda d: d["id"])
    head = "| City | " + " | ".join(f"`{d['id']}` L{d['level']}" for d in ds) + " |"
    rule = "|---|" + "---:|" * len(ds)
    rows = []
    for city in cities:
        cells = []
        for d in ds:
            r = next((r for r in d.get("regions", []) if r["name"] == city), None)
            cells.append("—" if r is None else f"{r.get('cells', 0):,}")
        rows.append(f"| {city} | " + " | ".join(cells) + " |")
    have = sum(1 for d in ds for c in cities if any(r["name"] == c for r in d.get("regions", [])))
    foot = f"\n{have} of {len(ds) * len(cities)} city × dataset slots filled."
    return "\n".join([head, rule, *rows]) + "\n" + foot


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--write", action="store_true", help=f"update the table in {DOC.name}")
    a = p.parse_args(argv)
    table = matrix(json.loads(CATALOG.read_text()))
    if not a.write:
        print(table)
        return 0
    text = DOC.read_text()
    block = f"{START}\n{table}\n{END}"
    if START in text:
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: block, text, flags=re.S)
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    DOC.write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
