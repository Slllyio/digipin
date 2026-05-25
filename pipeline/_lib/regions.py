"""Named geographic regions for GEE pipeline exports.

The pipeline scripts (pipeline/growth/, pipeline/heat/) used to hardcode
INDIA_BBOX = (68.0, 6.5, 97.5, 35.5) — ~3.2M km² of pixels. For the
Indore pilot we only need ~1800 km² (Indore + suburbs). That's a 1500×
reduction in COG size on disk + 1500× faster fetch over 4G mobile.

Resolution path:
  - Pilot default     → INDORE_PILOT
  - Override          → set DIGIPIN_REGION=india_full
  - New cities later  → add a new entry below + ship a per-city COG

Bounding boxes are (west, south, east, north) in WGS84 degrees,
matching GEE's ee.Geometry.Rectangle convention.
"""

from __future__ import annotations

import os
from typing import Final

# ~40 × 45 km centred on Indore. Captures Indore municipal + suburbs +
# Pithampur industrial belt — the full DigiPin pilot extent.
INDORE_PILOT: Final[tuple[float, float, float, float]] = (75.6, 22.5, 76.0, 22.9)

# Full India bbox. Use only when the workload genuinely needs national
# coverage (e.g. a multi-city analysis); never for COG exports the
# Indore frontend will fetch.
INDIA_FULL: Final[tuple[float, float, float, float]] = (68.0, 6.5, 97.5, 35.5)

_REGIONS: Final[dict[str, tuple[float, float, float, float]]] = {
    "indore_pilot": INDORE_PILOT,
    "india_full": INDIA_FULL,
}


def get_default_bbox() -> tuple[float, float, float, float]:
    """Return the bbox keyed by the DIGIPIN_REGION env var.

    Default: INDORE_PILOT. Override by exporting DIGIPIN_REGION=india_full
    before invoking the pipeline script.
    """
    name = os.environ.get("DIGIPIN_REGION", "indore_pilot").strip().lower()
    if name not in _REGIONS:
        raise ValueError(
            f"unknown DIGIPIN_REGION={name!r}; expected one of {sorted(_REGIONS)}"
        )
    return _REGIONS[name]


def get_default_region_name() -> str:
    """Return the active region name for output-path tagging."""
    return os.environ.get("DIGIPIN_REGION", "indore_pilot").strip().lower()
