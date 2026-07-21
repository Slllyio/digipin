"""Normalize each real-time feed's records into `HazardEvent`s.

Every feed shares the snapshot envelope written by
`scrapers/lib/storage.write_latest_snapshot`:
``{"generated_at_iso": ..., "count": ..., "records": [...]}``.
Per-source parsers below map that source's fields onto the common model
(hazard vocabulary + 0..1 severity). Empty or key-gated feeds (imd_*, openaq
when unconfigured) simply yield nothing.
"""
from __future__ import annotations

import json
from email.utils import parsedate_to_datetime
from typing import Callable, Iterable

from pipeline._lib import io
from .model import HazardEvent, clamp01

# ---- severity / hazard lookup tables -------------------------------------

_NDMA_SEV = {"minor": 0.25, "moderate": 0.5, "severe": 0.75, "extreme": 1.0}
_NDMA_HAZ = {
    "met-storm": "storm", "met-heat": "heat", "met-cyclone": "cyclone",
    "met-flood": "flood", "geo-earthquake": "earthquake",
    "geo-landslide": "landslide", "fire": "fire", "other": "other",
}
_IMD_COLOR = {"green": 0.1, "yellow": 0.4, "orange": 0.7, "red": 1.0}
_GDACS_LEVEL = {"green": 0.2, "orange": 0.6, "red": 1.0}
_GDACS_HAZ = {
    "eq": "earthquake", "tc": "cyclone", "fl": "flood", "vo": "other",
    "dr": "drought", "wf": "fire", "wg": "storm",
}


def _rfc822_to_iso(s: str) -> str:
    """Best-effort RFC-822 (RSS) → ISO-8601; passes ISO/other strings through unchanged."""
    if not s:
        return ""
    try:
        return parsedate_to_datetime(s).isoformat()
    except (TypeError, ValueError, IndexError):
        return s


def _quake_severity(mag) -> tuple:
    """Magnitude → (0..1 severity, label). ~M3 floor, ~M8 ceiling."""
    try:
        m = float(mag)
    except (TypeError, ValueError):
        return 0.0, "Unknown"
    sev = clamp01((m - 3.0) / 5.0)
    label = ("Great" if m >= 8 else "Major" if m >= 7 else "Strong" if m >= 6
             else "Moderate" if m >= 5 else "Light" if m >= 4 else "Minor")
    return sev, f"M{m:.1f} {label}"


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---- per-source normalizers ----------------------------------------------
# Each takes one record dict and returns a HazardEvent, or None to drop it.

def _ndma(r: dict) -> HazardEvent:
    sev = _NDMA_SEV.get(str(r.get("severity", "")).lower(), 0.4)
    haz = _NDMA_HAZ.get(str(r.get("category", "")).lower(), "other")
    return HazardEvent(
        source="ndma_sachet", event_id=str(r.get("id", "")), hazard=haz,
        severity=sev, severity_label=str(r.get("severity", "") or "Unknown"),
        headline=r.get("headline", ""), area_text=r.get("area", ""),
        time_utc=_rfc822_to_iso(r.get("published_utc", "")),
        url=r.get("cap_xml_url", ""),
    )


def _imd_warn(r: dict) -> HazardEvent:
    sev = _IMD_COLOR.get(str(r.get("color", "")).lower(), 0.3)
    return HazardEvent(
        source="imd_warnings", event_id=str(r.get("id", "")), hazard="storm",
        severity=sev, severity_label=str(r.get("severity", "") or r.get("color", "") or "Unknown"),
        headline=" ".join(str(h) for h in (r.get("hazards") or [])) or "IMD district warning",
        area_text=r.get("district_name", ""),
        time_utc=str(r.get("valid_date", "") or ""),
    )


def _imd_nowcast(r: dict) -> HazardEvent:
    sev = _IMD_COLOR.get(str(r.get("color", "")).lower(), 0.3)
    return HazardEvent(
        source="imd_nowcast", event_id=str(r.get("id", "")), hazard="storm",
        severity=sev, severity_label=str(r.get("severity", "") or r.get("color", "") or "Unknown"),
        headline=r.get("message", "") or "IMD nowcast",
        area_text=r.get("district_name", ""),
        time_utc=str(r.get("observation_time", "") or ""),
    )


def _ncs_quake(r: dict) -> HazardEvent:
    sev, label = _quake_severity(r.get("magnitude"))
    return HazardEvent(
        source="ncs_earthquakes", event_id=str(r.get("id", "")), hazard="earthquake",
        severity=sev, severity_label=label,
        headline=r.get("location", "") or r.get("region", "") or "Earthquake",
        area_text=" ".join(filter(None, [r.get("region", ""), r.get("location", "")])),
        time_utc=str(r.get("origin_time", "") or ""),
        lat=_num(r.get("latitude")), lng=_num(r.get("longitude")),
    )


def _usgs_quake(r: dict) -> HazardEvent:
    sev, label = _quake_severity(r.get("magnitude"))
    if r.get("tsunami"):
        sev = clamp01(max(sev, 0.9))
        label += " + tsunami"
    return HazardEvent(
        source="usgs_earthquakes", event_id=str(r.get("id", "")), hazard="earthquake",
        severity=sev, severity_label=label,
        headline=r.get("place", "") or "Earthquake",
        area_text=r.get("place", ""), time_utc=r.get("origin_time_utc", "") or "",
        url=r.get("url", ""), lat=_num(r.get("latitude")), lng=_num(r.get("longitude")),
    )


def _gdacs(r: dict) -> HazardEvent:
    lvl = str(r.get("alert_level", "")).lower()
    score = _num(r.get("alert_score"))
    sev = clamp01(score) if score is not None else _GDACS_LEVEL.get(lvl, 0.3)
    haz = _GDACS_HAZ.get(str(r.get("event_type", "")).lower(), "other")
    return HazardEvent(
        source="gdacs_disasters", event_id=str(r.get("id", "")), hazard=haz,
        severity=sev, severity_label=str(r.get("alert_level", "") or "Unknown"),
        headline=r.get("title", "") or r.get("event_label", "") or "Disaster",
        area_text=r.get("country", ""), time_utc=_rfc822_to_iso(r.get("published_utc", "")),
        url=r.get("url", ""), lat=_num(r.get("latitude")), lng=_num(r.get("longitude")),
    )


def _openaq(r: dict) -> HazardEvent:
    # Severity from the worst PM reading available (µg/m³, ~250 = severe).
    worst = 0.0
    for s in (r.get("sensors") or []):
        if str(s.get("parameter", "")).lower() in ("pm25", "pm10"):
            v = _num(s.get("lastValue"))
            if v is not None:
                worst = max(worst, v)
    return HazardEvent(
        source="openaq_india", event_id=str(r.get("id", "")), hazard="air",
        severity=clamp01(worst / 250.0), severity_label=f"PM {worst:.0f} µg/m³" if worst else "No reading",
        headline=r.get("name", "") or "Air-quality station",
        area_text=r.get("locality", "") or r.get("country", ""),
        lat=_num(r.get("latitude")), lng=_num(r.get("longitude")),
    )


# source id → (normalizer, drop-if-severity-below). imd_cityforecast is a plain
# forecast (no hazard/severity) and is intentionally omitted.
_PARSERS: dict = {
    "ndma_sachet": _ndma,
    "imd_warnings": _imd_warn,
    "imd_nowcast": _imd_nowcast,
    "ncs_earthquakes": _ncs_quake,
    "usgs_earthquakes": _usgs_quake,
    "gdacs_disasters": _gdacs,
    "openaq_india": _openaq,
}

DEFAULT_SOURCES = tuple(_PARSERS.keys())


def normalize(source: str, snapshot: dict) -> list:
    """Normalize one source's snapshot dict into HazardEvents (empty for unknown/empty)."""
    parser: Callable = _PARSERS.get(source)
    if not parser:
        return []
    out = []
    for rec in (snapshot or {}).get("records", []) or []:
        try:
            ev = parser(rec)
        except Exception:  # noqa: BLE001 — one bad record must not sink the feed
            continue
        if ev is not None:
            out.append(ev)
    return out


def load_snapshot(source: str, realtime_dir=None) -> dict:
    """Load data/realtime/<source>/latest.json; {} if missing/unreadable."""
    path = (realtime_dir / source / "latest.json") if realtime_dir else io.data_dir("realtime", source) / "latest.json"
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def load_events(sources: Iterable = DEFAULT_SOURCES, realtime_dir=None) -> list:
    """Load + normalize every source into a flat list of HazardEvents."""
    events = []
    for src in sources:
        events.extend(normalize(src, load_snapshot(src, realtime_dir)))
    return events
