"""Python port of the GrowthScore model (js/growth-score.js).

Phase 0 of docs/PRECOMPUTE_PLAN.md: the pipeline needs to compute the same
scores server-side that the browser computes per click, so coverage can be
precomputed into tiles. This module is a faithful, side-effect-free port.

Parity with the JavaScript original is enforced by a golden-file test
(tests/test_growth_parity.py): the golden fixtures are generated *from the JS*
(the source of truth) and this port must reproduce them. See README.md.

Porting notes — the two things that bite when porting JS number math:
  * ``js_round`` replicates JavaScript ``Math.round`` (round half toward
    +Infinity), which differs from Python's banker's rounding.
  * ``None`` stands in for both ``null`` and ``undefined``; dict access uses
    ``.get`` so a missing sub-score behaves like JS ``sub[dim] != null``.
"""
from __future__ import annotations

import math
from typing import Optional

__all__ = [
    "js_round", "norm_log", "bue_sub_score", "den_sub_score", "cap_sub_score",
    "composite", "linear_trend", "emerging_class", "confidence_band",
    "HORIZON_WEIGHTS",
]


def js_round(x: float) -> int:
    """JavaScript ``Math.round``: round half toward +Infinity."""
    return math.floor(x + 0.5)


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def norm_log(val: float, anchor: float) -> int:
    """Log-scale normaliser mapping 0..anchor to 0..100."""
    if val <= 0:
        return 0
    return min(100, js_round((math.log(1 + val) / math.log(1 + anchor)) * 100))


def bue_sub_score(d: dict) -> Optional[float]:
    """Built-up Expansion (BUE). Returns 0..100 or None."""
    bt = d.get("buildings_temporal")
    if not bt or len(bt) < 2:
        return None
    last, prev = bt[-1], bt[-2]
    if not _finite(last) or not _finite(prev):
        return None
    yoy_pct = ((last - prev) / prev) * 100 if prev > 0 else 0
    heights = d.get("heights")
    has_h = bool(heights) and len(heights) >= 2
    h1 = heights[-1] if has_h else None
    h0 = heights[-2] if has_h else None
    height_yoy = (h1 - h0) if (_finite(h1) and _finite(h0)) else 0
    osm_boost = min(10, (d.get("osm_construction_count") or 0) * 2)
    score = 50 + 25 * math.tanh(yoy_pct / 8) + 15 * math.tanh(height_yoy) + osm_boost
    return max(0, min(100, score)) if math.isfinite(score) else None


def den_sub_score(d: dict) -> Optional[float]:
    """Densification (DEN). Returns 0..100 or None."""
    pop = d.get("ghsl_pop_5yr_pct")
    if pop is None or not _finite(pop):
        return None
    pop_term = 25 * math.tanh(pop / 15)
    comm_term = min(15, (d.get("osm_commercial_density") or 0) / 8)
    return max(0, min(100, 50 + pop_term + comm_term))


def cap_sub_score(d: dict) -> Optional[float]:
    """Capital Flow (CAP). None = source unavailable; [] = no projects."""
    projects = d.get("rera_projects")
    if projects is None:
        return None
    if len(projects) == 0:
        return 0
    weighted = 0.0
    for p in projects:
        w = math.exp(-p["age_yrs"] / 2) * math.exp(-p["distance_km"] / 1.5)
        weighted += (p.get("value") or 0) * w
    return norm_log(weighted, 500_000_000)


HORIZON_WEIGHTS = {
    "nowcast": {"bue": 0.4, "den": 0.3, "cap": 0.3},
    "year_2":  {"bue": 0.2, "den": 0.2, "cap": 0.6},
    "year_5":  {"bue": 0.4, "den": 0.3, "cap": 0.3},
}


def composite(sub: dict, horizon: str) -> dict:
    """Composite for one horizon; renormalises weights over present sub-scores."""
    base = HORIZON_WEIGHTS.get(horizon, HORIZON_WEIGHTS["nowcast"])
    total = 0.0
    effective = {"bue": 0.0, "den": 0.0, "cap": 0.0}
    for dim in ("bue", "den", "cap"):
        if sub.get(dim) is not None:
            effective[dim] = base[dim]
            total += base[dim]
    if total == 0:
        return {"composite": None, "effective_weights": effective}
    for dim in ("bue", "den", "cap"):
        effective[dim] = effective[dim] / total
    value = 0.0
    for dim in ("bue", "den", "cap"):
        if sub.get(dim) is not None:
            value += effective[dim] * sub[dim]
    return {"composite": js_round(value), "effective_weights": effective}


def linear_trend(values) -> Optional[dict]:
    """OLS trend on a uniformly-spaced series. None if fewer than 3 points."""
    if not values or len(values) < 3:
        return None
    n = len(values)
    xs = list(range(n))
    mean_x = sum(xs) / n
    mean_y = sum(values) / n
    num = den = tot_ss = 0.0
    for i in range(n):
        num += (xs[i] - mean_x) * (values[i] - mean_y)
        den += (xs[i] - mean_x) ** 2
        tot_ss += (values[i] - mean_y) ** 2
    slope = 0 if den == 0 else num / den
    intercept = mean_y - slope * mean_x
    res_ss = 0.0
    for i in range(n):
        pred = slope * xs[i] + intercept
        res_ss += (values[i] - pred) ** 2
    r_squared = 1 if tot_ss == 0 else max(0, min(1, 1 - res_ss / tot_ss))
    return {"slope": slope, "intercept": intercept, "r_squared": r_squared}


def emerging_class(level, slope, opts: Optional[dict] = None) -> Optional[dict]:
    """Emerging-hotspot taxonomy from current level x temporal trend."""
    if level is None or not _finite(level):
        return None
    opts = opts or {}
    hot_level = opts["hotLevel"] if opts.get("hotLevel") is not None else 60
    eps = opts["slopeEps"] if opts.get("slopeEps") is not None else 0.5
    s = slope if _finite(slope) else 0
    hot = level >= hot_level
    rising = s > eps
    falling = s < -eps
    if hot and rising:
        return {"category": "intensifying", "color": "#b2182b", "label": "Intensifying Hotspot"}
    if hot and falling:
        return {"category": "diminishing", "color": "#ef8a62", "label": "Diminishing Hotspot"}
    if hot:
        return {"category": "persistent", "color": "#d6604d", "label": "Persistent Hotspot"}
    if rising:
        return {"category": "emerging", "color": "#fddbc7", "label": "Emerging (new) Hotspot"}
    if falling:
        return {"category": "cooling", "color": "#67a9cf", "label": "Cooling"}
    return {"category": "stable", "color": "#f7f7f7", "label": "Stable / no pattern"}


def confidence_band(horizon: str, r_squared) -> int:
    """Per-horizon confidence band (+/- value)."""
    if horizon == "nowcast":
        return 5
    if horizon == "year_2":
        return 10
    r2 = 0 if (r_squared is None or r_squared < 0) else r_squared
    return max(10, js_round(25 * (1 - r2)))
