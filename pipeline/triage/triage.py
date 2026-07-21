"""Rank correlated hazards and assemble the triage result.

priority = severity x hazard-relevance x exposure-factor, scaled to 0..100.
Exposure comes from the score tile: population for most hazards, blended with
flood_risk for floods. Geo-located hazards use the cells within ~6 km; name-only
hazards use the whole-region aggregate.
"""
from __future__ import annotations

from . import correlate, scoretile

_NEAR_RADIUS_M = 6000.0


def _exposure_factor(hazard: str, expo: dict) -> float:
    """0.4..1.0 — exposure lifts priority but never zeroes a severe hazard."""
    pop = (expo.get("pop_p90") or expo.get("pop_mean") or 0) / 100.0
    if hazard == "flood":
        flood = (expo.get("flood_p90") or expo.get("flood_mean") or 0) / 100.0
        base = 0.6 * pop + 0.4 * flood
    else:
        base = pop
    base = 0.0 if base < 0 else 1.0 if base > 1 else base
    return round(0.4 + 0.6 * base, 4)


def priority(event, expo: dict) -> float:
    return round(100.0 * event.severity * event.relevance() * _exposure_factor(event.hazard, expo), 1)


def _alert(event, expo: dict, matched_by: str) -> dict:
    return {
        "priority": priority(event, expo),
        "hazard": event.hazard,
        "severity": round(event.severity, 3),
        "severity_label": event.severity_label,
        "source": event.source,
        "event_id": event.event_id,
        "headline": (event.headline or "")[:280],
        "area_text": (event.area_text or "")[:160],
        "time_utc": event.time_utc,
        "url": event.url,
        "matched_by": matched_by,
        "lat": event.lat,
        "lng": event.lng,
        "exposure": {
            "pop_p90": expo.get("pop_p90"),
            "flood_p90": expo.get("flood_p90"),
            "cells": expo.get("cell_count"),
        },
    }


def triage(events, region_id: str, coverage=None, scores_dir=None) -> dict:
    """Correlate + rank events for a region → a serializable triage result."""
    cells = scoretile.load_cells(region_id, coverage, scores_dir)
    region_expo = scoretile.region_exposure(region_id, cells=cells)
    matches = correlate.match_events(events, region_id)

    alerts = []
    for m in matches:
        e = m.event
        if m.matched_by == "coords":
            near = scoretile.cells_near(region_id, e.lat, e.lng, _NEAR_RADIUS_M, cells=cells)
            expo = near if near["cell_count"] > 0 else region_expo
        else:
            expo = region_expo
        alerts.append(_alert(e, expo, m.matched_by))

    alerts.sort(key=lambda a: a["priority"], reverse=True)
    return {
        "region": region_id,
        "region_exposure": region_expo,
        "event_total": len(events),
        "matched_total": len(matches),
        "alerts": alerts,
    }
