"""Read the precomputed score tile (data/scores/) for population/flood exposure.

Shards are ``{dash-stripped-code: [20 ints]}`` aligned to
``coverage.json.fields``; cell geometry is recovered with
``digipin.decode_partial`` on the key. All lookups here are read-only.
"""
from __future__ import annotations

import json
import math

from pipeline._lib import digipin, io

_POP = "population_proxy"
_FLOOD = "flood_risk"


def load_coverage(scores_dir=None) -> dict:
    """Load data/scores/coverage.json (or <scores_dir>/coverage.json); {} if missing."""
    path = (scores_dir / "coverage.json") if scores_dir else io.data_dir("scores") / "coverage.json"
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _region_entry(coverage: dict, region_id: str):
    for r in coverage.get("regions", []):
        if r.get("name") == region_id:
            return r
    return None


def load_cells(region_id: str, coverage=None, scores_dir=None) -> list:
    """Decode a region's shards → [{code, lat, lng, scores:{field:value}}]."""
    coverage = coverage if coverage is not None else load_coverage(scores_dir)
    fields = coverage.get("fields", [])
    entry = _region_entry(coverage, region_id)
    if not entry or not fields:
        return []
    cells = []
    for prefix in entry.get("shards", []):
        shard_path = (scores_dir / region_id / f"{prefix}.json") if scores_dir else io.data_dir("scores", region_id) / f"{prefix}.json"
        try:
            with open(shard_path, encoding="utf-8") as f:
                shard = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            continue
        for code, arr in shard.items():
            if not isinstance(arr, list):
                continue
            try:
                dec = digipin.decode_partial(code)
            except Exception:  # noqa: BLE001 — a malformed key must not sink the shard
                continue
            scores = {fields[i]: arr[i] for i in range(min(len(fields), len(arr)))}
            cells.append({"code": code, "lat": dec["lat"], "lng": dec["lng"], "scores": scores})
    return cells


def _mean(vals):
    return (sum(vals) / len(vals)) if vals else 0.0


def _pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    k = (len(s) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return float(s[lo])
    return float(s[lo] + (s[hi] - s[lo]) * (k - lo))


def _summarize(cells: list) -> dict:
    pop = [(c["scores"].get(_POP) or 0) for c in cells]
    flood = [(c["scores"].get(_FLOOD) or 0) for c in cells]
    return {
        "cell_count": len(cells),
        "pop_mean": round(_mean(pop), 1),
        "pop_p90": round(_pct(pop, 90), 1),
        "pop_max": max(pop) if pop else 0,
        "flood_mean": round(_mean(flood), 1),
        "flood_p90": round(_pct(flood, 90), 1),
    }


def region_exposure(region_id: str, coverage=None, scores_dir=None, cells=None) -> dict:
    """Aggregate population/flood exposure over a whole region."""
    cells = cells if cells is not None else load_cells(region_id, coverage, scores_dir)
    return _summarize(cells)


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def cells_near(region_id: str, lat, lng, radius_m, coverage=None, scores_dir=None, cells=None) -> dict:
    """Exposure summary over cells within `radius_m` of a point (for geo-located hazards)."""
    cells = cells if cells is not None else load_cells(region_id, coverage, scores_dir)
    near = [c for c in cells if _haversine_m(lat, lng, c["lat"], c["lng"]) <= radius_m]
    return _summarize(near)
