"""Analysis-grid enumeration over DIGIPIN cells.

Phase 0 step 1 of docs/PRECOMPUTE_PLAN.md: to precompute coverage we enumerate
every DIGIPIN cell at a chosen *level* (code length) that intersects a bounding
box, then score each cell.

Why this is exact rather than sampled: DIGIPIN subdivides by exactly 4 at every
level with no remainder, so the level-k partition is a uniform 4**k x 4**k grid
over the India bounds. A cell is therefore addressed by an integer (row, col)
index, and encoding that cell's centre yields its k-character code. We walk the
integer index range covering the bbox — no float-stepping drift, no missed or
duplicated edge cells.
"""
from __future__ import annotations

import math
from typing import Optional

from pipeline._lib import digipin

# DIGIPIN level -> approximate cell edge length, for picking an analysis grid.
# (India span ~36 deg / 4**k, ~111 km/deg.)  level 8 ~ 15 m, 7 ~ 60 m, 6 ~ 240 m.
LEVEL_APPROX_METRES = {3: 15600, 4: 3900, 5: 975, 6: 244, 7: 61, 8: 15}


def _clamp(v, lo, hi):
    return max(lo, min(v, hi))


def cells_for_bbox(bbox: dict, level: int, max_cells: Optional[int] = None) -> list:
    """Enumerate DIGIPIN cells at ``level`` intersecting ``bbox``.

    bbox: {"south", "north", "west", "east"} in degrees.
    Returns a list of {"code", "bounds", "center"} dicts (one per cell), with
    ``code`` dash-formatted. Empty list for a degenerate or out-of-India bbox.
    Raises ValueError if the cell count would exceed ``max_cells``.
    """
    if not (3 <= level <= 10):
        raise ValueError(f"level must be in [3, 10], got {level}")

    b = digipin.BOUNDS
    n = 4 ** level
    lat_step = (b["maxLat"] - b["minLat"]) / n
    lon_step = (b["maxLon"] - b["minLon"]) / n

    south = max(bbox["south"], b["minLat"])
    north = min(bbox["north"], b["maxLat"])
    west = max(bbox["west"], b["minLon"])
    east = min(bbox["east"], b["maxLon"])
    if south >= north or west >= east:
        return []

    r0 = _clamp(math.floor((south - b["minLat"]) / lat_step), 0, n - 1)
    r1 = _clamp(math.floor((north - b["minLat"]) / lat_step), 0, n - 1)
    c0 = _clamp(math.floor((west - b["minLon"]) / lon_step), 0, n - 1)
    c1 = _clamp(math.floor((east - b["minLon"]) / lon_step), 0, n - 1)

    count = (r1 - r0 + 1) * (c1 - c0 + 1)
    if max_cells is not None and count > max_cells:
        raise ValueError(f"{count} cells exceeds max_cells={max_cells}")

    cells = {}
    for ri in range(r0, r1 + 1):
        center_lat = b["minLat"] + (ri + 0.5) * lat_step
        for ci in range(c0, c1 + 1):
            center_lon = b["minLon"] + (ci + 0.5) * lon_step
            code = digipin.encode(center_lat, center_lon).replace("-", "")[:level]
            if code not in cells:
                d = digipin.decode_partial(code)
                cells[code] = {
                    "code": digipin.format_pin(code),
                    "bounds": d["bounds"],
                    "center": {"lat": d["lat"], "lng": d["lng"]},
                }
    return list(cells.values())


def count_cells_for_bbox(bbox: dict, level: int) -> int:
    """Cell count without materialising them — for sizing a precompute job."""
    b = digipin.BOUNDS
    n = 4 ** level
    lat_step = (b["maxLat"] - b["minLat"]) / n
    lon_step = (b["maxLon"] - b["minLon"]) / n
    south = max(bbox["south"], b["minLat"])
    north = min(bbox["north"], b["maxLat"])
    west = max(bbox["west"], b["minLon"])
    east = min(bbox["east"], b["maxLon"])
    if south >= north or west >= east:
        return 0
    r0 = _clamp(math.floor((south - b["minLat"]) / lat_step), 0, n - 1)
    r1 = _clamp(math.floor((north - b["minLat"]) / lat_step), 0, n - 1)
    c0 = _clamp(math.floor((west - b["minLon"]) / lon_step), 0, n - 1)
    c1 = _clamp(math.floor((east - b["minLon"]) / lon_step), 0, n - 1)
    return (r1 - r0 + 1) * (c1 - c0 + 1)
