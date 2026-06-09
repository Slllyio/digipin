"""Gate a built scored tile before it is committed/deployed (A4).

Run against data/scores/ after build_tile. Fails (exit 1) on the failure modes
that would silently ship bad data: wrong cell count, out-of-range scores, a
degenerate all-identical grid (a silently-empty pbf), or a missing field. An
optional landmark assertion checks a known cell has an expected signal.

    python -m pipeline.scores.smoke_check data/scores --region indore_pilot
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pipeline._lib import grid


class SmokeFailure(AssertionError):
    pass


def _load_region(out_dir: Path, region: str):
    cov = json.loads((out_dir / "coverage.json").read_text())
    entry = next((r for r in cov["regions"] if r["name"] == region), None)
    if entry is None:
        raise SmokeFailure(f"region {region!r} absent from coverage.json")
    fields = cov["fields"]
    rows: dict[str, list] = {}
    for shard in (out_dir / region).glob("*.json"):
        if shard.name.startswith("_"):
            continue
        rows.update(json.loads(shard.read_text()))
    return entry, fields, rows


def check(out_dir, region: str = "indore_pilot", landmark: dict | None = None) -> dict:
    """Validate the region's tile. Raises SmokeFailure on any problem."""
    out_dir = Path(out_dir)
    entry, fields, rows = _load_region(out_dir, region)

    if not rows:
        raise SmokeFailure("no cells written")

    expected = grid.count_cells_for_bbox(entry["bbox"], entry["level"])
    if len(rows) != expected:
        raise SmokeFailure(f"cell count {len(rows)} != expected {expected}")

    n = len(fields)
    seen_distinct = set()
    for code, values in rows.items():
        if len(values) != n:
            raise SmokeFailure(f"cell {code}: {len(values)} values, expected {n}")
        for f, v in zip(fields, values):
            if not isinstance(v, (int, float)) or not (0 <= v <= 100):
                raise SmokeFailure(f"cell {code} field {f}={v!r} out of [0,100]")
        seen_distinct.add(tuple(values))

    # A silently-empty pbf scores every cell identically — catch it.
    if len(seen_distinct) < 2:
        raise SmokeFailure("degenerate grid: every cell has identical scores")

    if landmark:
        code = landmark["code"].replace("-", "")
        if code not in rows:
            raise SmokeFailure(f"landmark cell {landmark['code']} not in tile")
        idx = fields.index(landmark["field"])
        got = rows[code][idx]
        if got < landmark.get("min", 1):
            raise SmokeFailure(
                f"landmark {landmark['code']} {landmark['field']}={got} < {landmark.get('min', 1)}")

    return {"region": region, "cells": len(rows), "distinct": len(seen_distinct), "fields": n}


def main(argv=None):
    p = argparse.ArgumentParser(description="Smoke-check a built scored tile.")
    p.add_argument("out_dir", nargs="?", default="data/scores")
    p.add_argument("--region", default="indore_pilot")
    a = p.parse_args(argv)
    try:
        summary = check(a.out_dir, region=a.region)
    except SmokeFailure as e:
        print(f"SMOKE CHECK FAILED: {e}", file=sys.stderr)
        return 1
    print("SMOKE CHECK OK:", json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
