"""USGS — global earthquake feed.

Endpoint: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson

GeoJSON FeatureCollection, no auth, refreshed every minute. Complements
the NCS source (which is India-centric, 150-event scrolling window)
with a denser global view filtered to M4.5+.

Why a magnitude floor: the 'all_day' feed is huge (~10MB, thousands of
tiny events). M4.5+ is the threshold where DigiPin actually wants to
surface the event to a user — smaller quakes are seismology research
data, not user-facing context.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.usgs_earthquakes")

SOURCE_ID = "usgs_earthquakes"
FEED_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"


@dataclass
class Quake:
    id: str              # USGS event id (e.g. "us7000abcd")
    magnitude: float
    origin_time_utc: str
    latitude: float
    longitude: float
    depth_km: float
    place: str
    url: str             # USGS event page
    tsunami: int         # 0 / 1 — USGS tsunami flag
    significance: int    # USGS 'sig' score (higher = more newsworthy)

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "magnitude", "origin_time_utc", "latitude", "longitude",
            "depth_km", "place", "url", "tsunami", "significance",
        ]


def fetch(client: PoliteClient) -> list[Quake]:
    body = client.get(FEED_URL)
    if body is None:
        return []
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as e:
        log.error("USGS GeoJSON parse error: %s", e)
        return []

    quakes: list[Quake] = []
    for feat in payload.get("features", []):
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if len(coords) < 3:
            continue
        lng, lat, depth = coords[:3]
        epoch_ms = props.get("time")
        try:
            origin_utc = datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).isoformat()
        except (TypeError, ValueError):
            origin_utc = ""

        quakes.append(Quake(
            id=str(feat.get("id", "")),
            magnitude=float(props.get("mag") or 0.0),
            origin_time_utc=origin_utc,
            latitude=float(lat),
            longitude=float(lng),
            depth_km=float(depth),
            place=str(props.get("place") or ""),
            url=str(props.get("url") or ""),
            tsunami=int(props.get("tsunami") or 0),
            significance=int(props.get("sig") or 0),
        ))

    log.info("USGS: %d earthquake(s) M>=4.5 in past 24h", len(quakes))
    return quakes


def key_for(record: Quake) -> str:
    return record.id
