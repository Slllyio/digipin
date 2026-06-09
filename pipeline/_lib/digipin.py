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
