"""OpenAQ v3 — station-level air quality across India.

Endpoint: https://api.openaq.org/v3/locations?iso=IN&limit=1000

OpenAQ is a global open-data aggregator that pulls from CPCB (India's
official source) AND from independent monitors (research, embassies,
citizen networks). For DigiPin this means **denser station coverage**
than the CPCB-only feed we use today via data.gov.in — particularly
useful in Tier 2/3 cities where CPCB has 1-2 stations but OpenAQ may
expose 5-10 once you count independent monitors.

Auth (REQUIRED):
    X-API-Key: <key from explore.openaq.org/account>
    Register free at https://explore.openaq.org/register

Set as env var (or repo secret for CI):
    export OPENAQ_API_KEY=...

Graceful when unset — same pattern as the IMD sources.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.openaq_india")

SOURCE_ID = "openaq_india"
ENDPOINT = "https://api.openaq.org/v3/locations"


@dataclass
class Station:
    id: str                          # OpenAQ location id (stringified)
    name: str
    locality: str                    # city / area
    country: str
    latitude: float
    longitude: float
    is_mobile: bool
    is_monitor: bool
    sensors: list[dict] = field(default_factory=list)   # [{parameter, lastValue, units, datetimeLast}]
    provider: str = ""               # data source within OpenAQ
    timezone: str = ""

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "name", "locality", "country",
            "latitude", "longitude", "is_mobile", "is_monitor",
            "sensors", "provider", "timezone",
        ]


def _auth_header() -> dict[str, str] | None:
    key = os.environ.get("OPENAQ_API_KEY")
    if not key:
        return None
    return {"X-API-Key": key}


def _parse_sensor(s: dict) -> dict:
    """Reduce an OpenAQ sensor object to the fields the portal needs."""
    param = s.get("parameter") or {}
    latest = s.get("latest") or {}
    return {
        "parameter": param.get("name", ""),
        "units": param.get("units", ""),
        "lastValue": latest.get("value"),
        "datetimeLast": (latest.get("datetime") or {}).get("utc", ""),
    }


def _parse_location(loc: dict) -> Station | None:
    coords = loc.get("coordinates") or {}
    lat = coords.get("latitude")
    lng = coords.get("longitude")
    if lat is None or lng is None:
        return None
    return Station(
        id=str(loc.get("id", "")),
        name=loc.get("name", "") or "",
        locality=loc.get("locality", "") or "",
        country=((loc.get("country") or {}).get("code") or ""),
        latitude=float(lat),
        longitude=float(lng),
        is_mobile=bool(loc.get("isMobile", False)),
        is_monitor=bool(loc.get("isMonitor", True)),
        sensors=[_parse_sensor(s) for s in (loc.get("sensors") or [])],
        provider=((loc.get("provider") or {}).get("name") or ""),
        timezone=loc.get("timezone", "") or "",
    )


def fetch(client: PoliteClient) -> list[Station]:
    headers = _auth_header()
    if headers is None:
        log.warning(
            "OPENAQ_API_KEY not set — skipping openaq_india. "
            "Register free at https://explore.openaq.org/register and "
            "set OPENAQ_API_KEY to enable."
        )
        return []

    client._session.headers.update(headers)

    stations: list[Station] = []
    page = 1
    page_size = 1000   # OpenAQ v3 max page size; one page covers India
    while page <= 3:    # safety cap; India has ~300-700 stations on OpenAQ
        params = {"iso": "IN", "limit": page_size, "page": page}
        body = client.get(ENDPOINT, params=params)
        if body is None:
            break
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            log.error("non-JSON response on page %d", page)
            break

        results = payload.get("results") or []
        if not results:
            break
        for loc in results:
            parsed = _parse_location(loc)
            if parsed is not None:
                stations.append(parsed)

        meta = payload.get("meta") or {}
        found = int(meta.get("found", 0))
        if len(stations) >= found:
            break
        page += 1
        client.polite_sleep()

    log.info("fetched %d OpenAQ station(s) for India", len(stations))
    return stations


def key_for(record: Station) -> str:
    return record.id
