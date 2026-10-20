"""Keep committed road GeoJSON under the repo's per-file budget.

tests/perf-budgets.test.js caps every file under data/ at 6 MB. A metro's
arterial network (Delhi: ~25k segments) at Overpass's 7-decimal precision is
~10 MB, so road files are written through ``dumps_lines``: coordinates are
rounded to 5 decimals (~1 m), lines are simplified with Ramer-Douglas-Peucker,
and the tolerance doubles until the JSON fits ``max_bytes``. Endpoints are
always kept, so the road graph built from them is unchanged.

``rdp`` and ``dumps_lines`` are pure (stdlib) and unit-tested.
"""
from __future__ import annotations

import json

MAX_BYTES = 5_500_000                 # headroom under the 6 MB test cap
TOLERANCES = (0.0, 1e-5, 2e-5, 4e-5, 8e-5, 1.6e-4)   # degrees (~0, 1, 2, 4, 9, 18 m)


def rdp(pts: list, eps: float) -> list:
    """Ramer-Douglas-Peucker simplification of a polyline (iterative)."""
    if eps <= 0 or len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a][:2], pts[b][:2]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5
        dmax, idx = 0.0, -1
        for i in range(a + 1, b):
            x, y = pts[i][:2]
            d = (abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm if norm
                 else ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5)
            if d > dmax:
                dmax, idx = d, i
        if dmax > eps:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def _line(coords, eps):
    return [[round(x, 5), round(y, 5)] for x, y, *_ in rdp(coords, eps)]


def dumps_lines(features: list, drop_props=(), max_bytes: int = MAX_BYTES) -> str:
    """Compact FeatureCollection JSON for LineString/MultiLineString features."""
    props = [{k: v for k, v in (f.get("properties") or {}).items() if k not in drop_props}
             for f in features]
    out = ""
    for eps in TOLERANCES:
        feats = []
        for f, p in zip(features, props):
            g = f.get("geometry") or {}
            if g.get("type") == "LineString":
                g = {"type": "LineString", "coordinates": _line(g["coordinates"], eps)}
            elif g.get("type") == "MultiLineString":
                g = {"type": "MultiLineString", "coordinates": [_line(c, eps) for c in g["coordinates"]]}
            feats.append({"type": "Feature", "geometry": g, "properties": p})
        out = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
        if len(out.encode()) <= max_bytes:
            break
    return out
