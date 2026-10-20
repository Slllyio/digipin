"""Turn the repo's existing per-area outputs into cell-store records.

Each adapter yields plain record dicts (``{"lat", "lng"} | {"digipin"}`` plus
field values) for ``store.bin_records``, so a new source only needs a reader —
never new rendering code. Three shapes exist in the repo today:

  * score shards    data/scores/<region>/<prefix>.json  {code: [v1..vN]}
  * regular grids   data/{traffic,safety}/<region>/*_grid.json (row-major, row 0 = north)
  * points / rows   any CSV or GeoJSON (see ``pipeline.cells.ingest``)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Iterator, Optional


def score_shard_records(scores_root, region: str) -> tuple[list, Iterator[dict]]:
    """(fields, records) from the precomputed score shards for ``region``.

    Codes are already DIGIPIN cells, so records carry ``digipin`` and the
    binning step is an identity mapping at the shards' level.
    """
    root = Path(scores_root)
    cov = json.loads((root / "coverage.json").read_text())
    reg = next((r for r in cov["regions"] if r["name"] == region), None)
    if reg is None:
        raise ValueError(f"region {region!r} not in {root / 'coverage.json'}")
    fields = cov["fields"]

    def gen():
        for prefix in reg.get("shards", []):
            p = root / region / f"{prefix}.json"
            if not p.exists():
                continue
            for code, values in json.loads(p.read_text()).items():
                rec = {"digipin": code}
                rec.update(zip(fields, values))
                yield rec

    return fields, gen()


def grid_records(grid: dict, keys: list,
                 keep: Optional[Callable[[dict], bool]] = None) -> Iterator[dict]:
    """Records at each pixel centre of a row-major regular grid.

    ``grid`` is the footprint-grid shape used by traffic_grid.json /
    mobility_grid.json: {bounds:{west,south,east,north}, nx, ny, <key>:[...]}.
    ``keep`` filters pixels (e.g. "has a road") so the store stays sparse.
    """
    b, nx, ny = grid["bounds"], int(grid["nx"]), int(grid["ny"])
    dx = (b["east"] - b["west"]) / nx
    dy = (b["north"] - b["south"]) / ny
    arrays = {k: grid.get(k) for k in keys}
    for y in range(ny):
        lat = b["north"] - (y + 0.5) * dy
        for x in range(nx):
            i = y * nx + x
            rec = {k: (a[i] if a is not None and i < len(a) else None) for k, a in arrays.items()}
            if keep is not None and not keep(rec):
                continue
            rec["lat"] = lat
            rec["lng"] = b["west"] + (x + 0.5) * dx
            yield rec
