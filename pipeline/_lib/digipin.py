"""Python port of the DIGIPIN encoder/decoder (js/digipin.js).

The addressing scheme for the whole app: a 10-character code names a ~4x4 m
cell, and truncating to k characters names a coarser ancestor cell. The
precompute pipeline (docs/PRECOMPUTE_PLAN.md, Phase 0 step 1) uses this to
enumerate the analysis grid and to key precomputed scores by cell.

Faithful, side-effect-free port; pinned to the JS output by
pipeline/scores/tests/test_digipin_parity.py.
"""
from __future__ import annotations

import math
from typing import Optional

GRID = [
    ["F", "C", "9", "8"],
    ["J", "3", "2", "7"],
    ["K", "4", "5", "6"],
    ["L", "M", "P", "T"],
]

BOUNDS = {"minLat": 2.5, "maxLat": 38.5, "minLon": 63.5, "maxLon": 99.5}

CHAR_TO_POS = {GRID[r][c]: (r, c) for r in range(4) for c in range(4)}

__all__ = ["encode", "decode", "decode_partial", "format_pin", "BOUNDS"]


def encode(lat: float, lon: float) -> str:
    """Encode lat/lon to a 10-character DIGIPIN with dashes (XXX-XXX-XXXX)."""
    if lat < BOUNDS["minLat"] or lat > BOUNDS["maxLat"]:
        raise ValueError(f"Latitude {lat} out of range [{BOUNDS['minLat']}, {BOUNDS['maxLat']}]")
    if lon < BOUNDS["minLon"] or lon > BOUNDS["maxLon"]:
        raise ValueError(f"Longitude {lon} out of range [{BOUNDS['minLon']}, {BOUNDS['maxLon']}]")

    min_lat, max_lat = BOUNDS["minLat"], BOUNDS["maxLat"]
    min_lon, max_lon = BOUNDS["minLon"], BOUNDS["maxLon"]
    pin = ""
    for level in range(1, 11):
        lat_div = (max_lat - min_lat) / 4
        lon_div = (max_lon - min_lon) / 4

        row = 3 - math.floor((lat - min_lat) / lat_div)
        col = math.floor((lon - min_lon) / lon_div)
        row = max(0, min(row, 3))
        col = max(0, min(col, 3))

        pin += GRID[row][col]
        if level == 3 or level == 6:
            pin += "-"

        max_lat = min_lat + lat_div * (4 - row)
        min_lat = min_lat + lat_div * (3 - row)
        min_lon = min_lon + lon_div * col
        max_lon = min_lon + lon_div
    return pin


def decode(digi_pin: str) -> dict:
    """Decode a full 10-char DIGIPIN to its center + bounding box."""
    pin = digi_pin.replace("-", "").upper()
    if len(pin) != 10:
        raise ValueError("Invalid DIGIPIN: must be 10 characters")
    return _decode_chars(pin)


def decode_partial(pin: str) -> dict:
    """Decode a partial DIGIPIN (fewer than 10 chars) to a coarser cell."""
    return _decode_chars(pin.replace("-", "").upper())


def _decode_chars(pin: str) -> dict:
    min_lat, max_lat = BOUNDS["minLat"], BOUNDS["maxLat"]
    min_lon, max_lon = BOUNDS["minLon"], BOUNDS["maxLon"]
    for ch in pin:
        pos = CHAR_TO_POS.get(ch)
        if pos is None:
            raise ValueError(f"Invalid character '{ch}' in DIGIPIN")
        row, col = pos
        lat_div = (max_lat - min_lat) / 4
        lon_div = (max_lon - min_lon) / 4
        lat1 = max_lat - lat_div * (row + 1)
        lat2 = max_lat - lat_div * row
        lon1 = min_lon + lon_div * col
        lon2 = min_lon + lon_div * (col + 1)
        min_lat, max_lat = lat1, lat2
        min_lon, max_lon = lon1, lon2
    return {
        "lat": (min_lat + max_lat) / 2,
        "lng": (min_lon + max_lon) / 2,
        "bounds": {"south": min_lat, "north": max_lat, "west": min_lon, "east": max_lon},
    }


def format_pin(code: str) -> str:
    """Format a DIGIPIN code with the standard dashes."""
    clean = code.replace("-", "")
    if len(clean) <= 3:
        return clean
    if len(clean) <= 6:
        return clean[:3] + "-" + clean[3:]
    return clean[:3] + "-" + clean[3:6] + "-" + clean[6:]


# ── Hierarchy (mirror of js/digipin.js; parity: tests/test_digipin_hierarchy.py) ──
#
# A level-L cell is one square of a uniform 4**L x 4**L grid over the 36 deg
# India box, addressed by an integer (row from the south, col from the west).

ALPHABET = "23456789CFJKLMPT"
MAX_LEVEL = 10
_SPAN = BOUNDS["maxLat"] - BOUNDS["minLat"]
M_PER_DEG = 111320
_DIRS = {"n": (1, 0), "ne": (1, 1), "e": (0, 1), "se": (-1, 1),
         "s": (-1, 0), "sw": (-1, -1), "w": (0, -1), "nw": (1, -1)}


def cell_degrees(level: int) -> float:
    """Cell edge in degrees at a level: 36 / 4**level (exact in binary)."""
    return _SPAN / 4 ** level


def cell_size_m(level: int) -> float:
    """North-south cell edge in metres (L6 ~978, L7 ~245, L8 ~61)."""
    return cell_degrees(level) * M_PER_DEG


def normalize(code: str) -> str:
    c = str(code).replace("-", "").strip().upper()
    if not (1 <= len(c) <= MAX_LEVEL) or any(ch not in ALPHABET for ch in c):
        raise ValueError(f"Invalid DIGIPIN '{code}'")
    return c


def to_index(code: str) -> dict:
    """Code -> {level, row, col}, row 0 = southernmost."""
    c = normalize(code)
    row = col = 0
    for ch in c:
        r, k = CHAR_TO_POS[ch]
        row = row * 4 + (3 - r)
        col = col * 4 + k
    return {"level": len(c), "row": row, "col": col}


def from_index(level: int, row: int, col: int):
    """(level, row, col) -> dash-less code, or None outside the grid."""
    n = 4 ** level
    if not (0 <= row < n and 0 <= col < n):
        return None
    out = []
    for i in range(level - 1, -1, -1):
        p = 4 ** i
        out.append(GRID[3 - (row // p) % 4][(col // p) % 4])
    return "".join(out)


def parent(code: str, level: Optional[int] = None):
    c = normalize(code)
    lv = len(c) - 1 if level is None else level
    return c[:lv] if 1 <= lv <= len(c) else None


def children(code: str) -> list:
    c = normalize(code)
    return [] if len(c) >= MAX_LEVEL else [c + ch for row in GRID for ch in row]


def neighbor(code: str, direction: str):
    dr, dc = _DIRS[direction]
    i = to_index(code)
    return from_index(i["level"], i["row"] + dr, i["col"] + dc)


def neighbors(code: str) -> dict:
    return {d: neighbor(code, d) for d in _DIRS}
