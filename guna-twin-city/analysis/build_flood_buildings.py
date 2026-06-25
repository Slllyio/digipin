"""Export per-building flood depth as a committed GeoJSON for the Guna map.

The precise flood model (flood_precise_analysis.py) samples DEM fill-spill flood
depth at every Google-Open-Buildings footprint and keeps the at-risk ones in
flood_precise_results.json (risk_buildings: flood_depth_m + risk class + a
simplified ring). This converts those into a small GeoJSON the map renders as 3D
buildings coloured by flood depth — i.e. the extent of building-level flood risk.

Pure JSON transform (no GDAL); run after the precise model has produced results.
"""
from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "output"
RESULTS = OUT / "flood_precise_results.json"
DEST = OUT / "flood_buildings_guna.geojson"


def _find_risk_buildings(obj):
    """Locate the risk_buildings list anywhere in the results structure."""
    if isinstance(obj, dict):
        if isinstance(obj.get("risk_buildings"), list):
            return obj["risk_buildings"]
        for v in obj.values():
            found = _find_risk_buildings(v)
            if found is not None:
                return found
    return None


def _ring_to_polygon(ring):
    """ring is [[lat, lon], ...]; GeoJSON Polygon wants a closed [[lon, lat], ...]."""
    coords = [[lon, lat] for lat, lon in ring]
    if coords and coords[0] != coords[-1]:
        coords.append(coords[0])
    return [coords]


def build() -> dict:
    if not RESULTS.exists():
        raise SystemExit(f"Missing {RESULTS.name} — run flood_precise_analysis.py first.")
    results = json.loads(RESULTS.read_text(encoding="utf-8"))
    risk = _find_risk_buildings(results) or []

    features = []
    by_risk: dict[str, int] = {}
    total_area = 0.0
    max_depth = 0.0
    for b in risk:
        ring = b.get("ring")
        if not ring or len(ring) < 3:
            continue
        depth = round(float(b.get("flood_depth_m", 0) or 0), 2)
        klass = b.get("risk", "flood_zone")
        area = float(b.get("area_m2", 0) or 0)
        total_area += area
        max_depth = max(max_depth, depth)
        by_risk[klass] = by_risk.get(klass, 0) + 1
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": _ring_to_polygon(ring)},
            "properties": {
                "flood_depth_m": depth,
                "risk": klass,
                "area_m2": round(area, 1),
                "action": b.get("action", ""),
            },
        })

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "DEM fill-spill (flood_precise_analysis.py), 328 mm/24h event",
            "building_source": "Google Open Buildings",
            "count": len(features),
            "by_risk": by_risk,
            "total_area_m2": round(total_area),
            "max_depth_m": round(max_depth, 2),
            "note": "Screening-level building flood exposure; not a validated design model.",
        },
        "features": features,
    }
    DEST.write_text(json.dumps(fc), encoding="utf-8")
    return fc["metadata"]


if __name__ == "__main__":
    meta = build()
    print(json.dumps(meta, indent=2))
