"""Export per-cell flood risk as a committed GeoJSON choropleth for the map.

flood_risk_analysis.py scores a ~500 m grid of zones (flood_risk_scores.json:
lat/lon centre + risk_score 0-40 + risk_level + contributing factors). This wraps
each zone in a square cell polygon so the map can render a green -> red flood-risk
heatmap per cell — for planning flood-prone areas, like a DIGIPIN-cell risk map.

Pure JSON transform; run after flood_risk_analysis.py has produced its scores.
"""
from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "output"
SRC = OUT / "flood_risk_scores.json"
DEST = OUT / "flood_risk_cells_guna.geojson"
HALF = 0.0025  # half of the ~0.005 deg (~500 m) scoring-grid spacing


def _square(lat: float, lon: float, h: float = HALF):
    return [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h],
             [lon - h, lat + h], [lon - h, lat - h]]]


def _event_context() -> dict:
    """Rain / water-level context from the flood analysis summary (for the legend)."""
    summary = OUT / "flood_analysis_summary.json"
    if not summary.exists():
        return {}
    ev = json.loads(summary.read_text(encoding="utf-8")).get("event", {})
    return {
        "rainfall_mm": ev.get("rainfall_mm"),
        "peak_intensity_mmh": ev.get("peak_intensity_mmh"),
        "water_level_m": ev.get("kalora_dam_breach_m") or ev.get("chambal_above_danger_m"),
        "date": ev.get("date"),
    }


def build() -> dict:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    zones = data.get("zones", [])
    features = []
    for z in zones:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": _square(z["lat"], z["lon"])},
            "properties": {
                "risk_score": z.get("risk_score", 0),
                "risk_level": z.get("risk_level", "low"),
                "factor": (z.get("factors") or [""])[0],
            },
        })
    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "count": len(features),
            "stats": data.get("stats", {}),
            "cell_m": round(HALF * 2 * 111000),
            "event": _event_context(),
            "source": "flood_risk_analysis.py — 328 mm/24h event",
            "note": "Screening-level per-cell flood risk for planning; not validated design.",
        },
        "features": features,
    }
    DEST.write_text(json.dumps(fc), encoding="utf-8")
    return fc["metadata"]


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
