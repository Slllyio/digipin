"""Normalized hazard model shared across the triage pipeline.

Eight heterogeneous feeds (earthquakes with coordinates, district-named IMD
warnings, country-level GDACS alerts, ...) collapse into one `HazardEvent` with
a common hazard vocabulary and a severity normalized to 0..1, so correlation and
ranking never have to special-case a source.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional

# Common hazard vocabulary every feed maps into.
HAZARDS = (
    "flood", "cyclone", "earthquake", "landslide", "fire",
    "storm", "heat", "air", "drought", "other",
)

# How much a hazard type drives triage priority (0..1). Life-safety, fast-onset
# hazards rank above chronic/monitoring ones.
HAZARD_RELEVANCE = {
    "earthquake": 1.0, "flood": 1.0, "cyclone": 1.0,
    "landslide": 0.9, "fire": 0.9,
    "storm": 0.8, "heat": 0.8, "drought": 0.7,
    "air": 0.6, "other": 0.5,
}


@dataclass
class HazardEvent:
    """A single normalized hazard from any feed."""
    source: str
    event_id: str
    hazard: str               # one of HAZARDS
    severity: float           # normalized 0..1
    severity_label: str = ""
    headline: str = ""
    area_text: str = ""       # free-text area/district/country, for name matching
    time_utc: str = ""        # best-effort ISO-8601 (may be "")
    url: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None

    def has_coords(self) -> bool:
        return self.lat is not None and self.lng is not None

    def relevance(self) -> float:
        return HAZARD_RELEVANCE.get(self.hazard, HAZARD_RELEVANCE["other"])

    def to_dict(self) -> dict:
        return asdict(self)


def clamp01(x: float) -> float:
    """Clamp a number into [0, 1]; non-numbers become 0."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if v < 0 else 1.0 if v > 1 else v
