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

import math
import os
from typing import Final

# ~40 × 45 km centred on Indore. Captures Indore municipal + suburbs +
# Pithampur industrial belt — the full DigiPin pilot extent.
INDORE_PILOT: Final[tuple[float, float, float, float]] = (75.6, 22.5, 76.0, 22.9)

# Full India bbox. Use only when the workload genuinely needs national
# coverage (e.g. a multi-city analysis); never for COG exports the
# Indore frontend will fetch.
INDIA_FULL: Final[tuple[float, float, float, float]] = (68.0, 6.5, 97.5, 35.5)

# Tier-1 metro pilots for Phase 1 (docs/PRECOMPUTE_PHASE1.md). Each is a tight
# metro bbox (west, south, east, north) keeping the cell count modest at level
# 6 (~244 m). Cell counts at L6 are listed in the runbook.
_REGIONS: Final[dict[str, tuple[float, float, float, float]]] = {
    "indore_pilot": INDORE_PILOT,
    "guna":       (77.25, 24.58, 77.40, 24.70),
    "bhopal":     (77.30, 23.18, 77.52, 23.32),
    "pune":       (73.75, 18.43, 73.99, 18.64),
    "mumbai":     (72.78, 18.89, 72.99, 19.27),
    "bengaluru":  (77.45, 12.83, 77.78, 13.14),
    "hyderabad":  (78.30, 17.30, 78.60, 17.55),
    "chennai":    (80.13, 12.90, 80.32, 13.18),
    "delhi":      (76.84, 28.40, 77.35, 28.88),
    "india_full": INDIA_FULL,
}

# Geofabrik India sub-extract each region's OSM data comes from. The pipeline
# downloads `<zone>-latest.osm.pbf`, then `osmium extract`s the region bbox —
# so a tile build needs only the region name to fetch the right ~1 GB extract.
_GEOFABRIK_ZONE: Final[dict[str, str]] = {
    "indore_pilot": "central-zone",   # Madhya Pradesh
    "bhopal":       "central-zone",
    "pune":         "western-zone",   # Maharashtra
    "mumbai":       "western-zone",
    "bengaluru":    "southern-zone",  # Karnataka / Tamil Nadu / Telangana
    "hyderabad":    "southern-zone",
    "chennai":      "southern-zone",
    "delhi":        "northern-zone",
}

_GEOFABRIK_BASE = "https://download.geofabrik.de/asia/india"
_DEM_BASE = "https://copernicus-dem-30m.s3.amazonaws.com"

# Tier-1 pilots wired for the Phase 1 matrix (excludes the national fallback).
CITY_PILOTS: Final[tuple[str, ...]] = tuple(_GEOFABRIK_ZONE.keys())


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


def bbox_for(region: str) -> tuple[float, float, float, float]:
    """(west, south, east, north) for a known region; raises on unknown."""
    if region not in _REGIONS:
        raise ValueError(f"unknown region {region!r}; known: {sorted(_REGIONS)}")
    return _REGIONS[region]


def geofabrik_url(region: str) -> str:
    """The Geofabrik `<zone>-latest.osm.pbf` URL a region's OSM data comes from."""
    zone = _GEOFABRIK_ZONE.get(region)
    if zone is None:
        raise ValueError(
            f"no Geofabrik extract mapped for region {region!r}; "
            f"city pilots: {sorted(_GEOFABRIK_ZONE)}"
        )
    return f"{_GEOFABRIK_BASE}/{zone}-latest.osm.pbf"


def clip_bbox_str(region: str, buffer_deg: float = 0.01) -> str:
    """`osmium extract -b` string (w,s,e,n), buffered so disc kernels at the
    region edge still see their ~400 m neighbourhood. Default ~1 km buffer."""
    w, s, e, n = bbox_for(region)
    return f"{w - buffer_deg:.4f},{s - buffer_deg:.4f},{e + buffer_deg:.4f},{n + buffer_deg:.4f}"


def dem_tiles_for(region: str, buffer_deg: float = 0.01) -> list[tuple[int, int]]:
    """Integer (lat, lon) corners of the 1°×1° Copernicus GLO-30 DEM tiles that
    cover a region's (buffered) bbox. India is wholly N/E, so both are >= 0."""
    w, s, e, n = bbox_for(region)
    lat0, lat1 = math.floor(s - buffer_deg), math.floor(n + buffer_deg)
    lon0, lon1 = math.floor(w - buffer_deg), math.floor(e + buffer_deg)
    return [(la, lo) for la in range(lat0, lat1 + 1) for lo in range(lon0, lon1 + 1)]


def dem_tile_urls(region: str, buffer_deg: float = 0.01) -> list[str]:
    """Public GLO-30 COG URLs (no auth) covering a region's bbox."""
    urls = []
    for la, lo in dem_tiles_for(region, buffer_deg):
        name = f"Copernicus_DSM_COG_10_N{la:02d}_00_E{lo:03d}_00_DEM"
        urls.append(f"{_DEM_BASE}/{name}/{name}.tif")
    return urls


def _main(argv: list[str] | None = None) -> int:
    """Tiny CLI so the CI workflow can resolve per-region inputs without
    duplicating the table in YAML, e.g.::

        EXTRACT_URL=$(python -m pipeline._lib.regions geofabrik-url pune)
        CLIP=$(python -m pipeline._lib.regions clip-bbox pune)
        python -m pipeline._lib.regions dem-urls pune   # newline-separated
    """
    import argparse

    p = argparse.ArgumentParser(prog="pipeline._lib.regions")
    sub = p.add_subparsers(dest="cmd", required=True)
    for cmd in ("geofabrik-url", "clip-bbox", "dem-urls", "bbox"):
        sp = sub.add_parser(cmd)
        sp.add_argument("region")
    sub.add_parser("list-cities")
    a = p.parse_args(argv)

    if a.cmd == "list-cities":
        print("\n".join(CITY_PILOTS))
    elif a.cmd == "geofabrik-url":
        print(geofabrik_url(a.region))
    elif a.cmd == "clip-bbox":
        print(clip_bbox_str(a.region))
    elif a.cmd == "dem-urls":
        print("\n".join(dem_tile_urls(a.region)))
    elif a.cmd == "bbox":
        print(",".join(str(x) for x in bbox_for(a.region)))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
