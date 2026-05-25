"""NCS (National Center for Seismology, MoES) — recent earthquakes.

Endpoint: https://riseq.seismo.gov.in/   (RISEQ — Real-time Information
System for Earthquakes from NCS / Ministry of Earth Sciences)

The page is server-rendered HTML containing a `<table id="eqdatalist">`
with the 150 most recent global earthquakes monitored by India's
seismic network. Each row exposes:
    Magnitude | Origin Time | Lat | Long | Depth (km) | Region |
    Location | Type | Did You Feel It?

No auth, no rate limit hint. We're polite anyway.

Why this over the seismo.gov.in main domain: that host has an SSL
legacy-renegotiation issue that blocks modern Python clients. RISEQ
serves the same data on a sibling subdomain with a working cert.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from bs4 import BeautifulSoup

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.ncs_earthquakes")

SOURCE_ID = "ncs_earthquakes"
FEED_URL = "https://riseq.seismo.gov.in/"


@dataclass
class Quake:
    id: str                  # composite: origin_time + lat + lng (unique per event)
    magnitude: float
    origin_time: str         # IST per NCS convention
    latitude: float
    longitude: float
    depth_km: float
    region: str
    location: str
    review_status: str       # "Reviewed" or "Automatic"

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "magnitude", "origin_time", "latitude", "longitude",
            "depth_km", "region", "location", "review_status",
        ]


def _to_float(value: str) -> float | None:
    if value is None:
        return None
    try:
        return float(value.strip())
    except (TypeError, ValueError):
        return None


def fetch(client: PoliteClient) -> list[Quake]:
    body = client.get(FEED_URL)
    if body is None:
        log.error("could not fetch RISEQ page")
        return []

    soup = BeautifulSoup(body, "html.parser")
    table = soup.find("table", id="eqdatalist")
    if table is None:
        log.error("eqdatalist table not found — NCS may have changed layout")
        return []

    rows = table.find_all("tr")
    if len(rows) <= 1:
        log.info("no earthquake rows in eqdatalist (table empty)")
        return []

    quakes: list[Quake] = []
    for row in rows[1:]:  # skip header
        cells = row.find_all("td")
        if len(cells) < 9:
            continue
        text = [c.get_text(" ", strip=True) for c in cells]
        magnitude, origin_time, lat, lng, depth, region, location, review, _felt = text[:9]

        mag = _to_float(magnitude)
        lat_f = _to_float(lat)
        lng_f = _to_float(lng)
        depth_f = _to_float(depth)
        if mag is None or lat_f is None or lng_f is None:
            continue

        # Composite id keeps a row unique even if NCS later revises the
        # magnitude or region label for the same event.
        record_id = f"{origin_time}|{lat_f:.3f},{lng_f:.3f}"

        quakes.append(Quake(
            id=record_id,
            magnitude=mag,
            origin_time=origin_time,
            latitude=lat_f,
            longitude=lng_f,
            depth_km=depth_f if depth_f is not None else 0.0,
            region=region,
            location=location,
            review_status=review,
        ))

    log.info("parsed %d earthquake row(s) from RISEQ", len(quakes))
    return quakes


def key_for(record: Quake) -> str:
    return record.id
