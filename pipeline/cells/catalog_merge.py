"""Merge dataset entries from one catalog.json into another.

    python -m pipeline.cells.catalog_merge baked.json data/cells/catalog.json --ids osm_roads osm_amenities

Several jobs and threads write ``data/cells/catalog.json`` at once, so a bake
that rebases onto a newer branch tends to conflict on it. A bake can instead save
its catalog, reset to the latest branch, put back its dataset directories and
merge just its own entries. For each id, the baked entry replaces the
dataset's spec, and its regions replace same-named regions. Regions the bake did
not touch are kept.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def merge(src: dict, dst: dict, ids=None) -> dict:
    by_id = {d["id"]: d for d in dst.get("datasets", [])}
    for d in src.get("datasets", []):
        if ids and d["id"] not in ids:
            continue
        old = by_id.get(d["id"])
        baked = {r["name"] for r in d.get("regions", [])}
        keep = [r for r in (old or {}).get("regions", []) if r["name"] not in baked]
        by_id[d["id"]] = {**d, "regions": sorted(keep + d.get("regions", []), key=lambda r: r["name"])}
    return {**dst, "version": dst.get("version", src.get("version", 1)),
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "datasets": sorted(by_id.values(), key=lambda d: d["id"])}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--ids", nargs="*", help="dataset ids to merge (default: all in src)")
    a = p.parse_args(argv)
    src = json.loads(Path(a.src).read_text())
    dst = json.loads(Path(a.dst).read_text()) if Path(a.dst).exists() else {}
    out = merge(src, dst, set(a.ids) if a.ids else None)
    Path(a.dst).write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps({"merged": a.ids or [d["id"] for d in src.get("datasets", [])]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
