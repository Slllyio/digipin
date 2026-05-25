"""IMD — district nowcast (real-time, next 3 hours).

Endpoint: https://api.imd.gov.in/api/v1/districtnowcast?id=<district_id>

Returns a numeric weather 'category' (1-19) per district with a
consolidated message and color severity. Categories cover the full
acute-weather spectrum from clear sky through extreme thunderstorms.

Auth: same as imd_warnings — IMD_API_KEY + IMD_API_TOKEN env vars.
See scrapers/sources/imd_warnings.py for the registration flow.

Reusing DEFAULT_DISTRICTS from imd_warnings keeps the two IMD sources
consistent. Override on the CLI via --districts when scraping elsewhere.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

from ..lib.http import PoliteClient
from .imd_warnings import DEFAULT_DISTRICTS, SEVERITY_BY_COLOR

log = logging.getLogger("scrapers.imd_nowcast")

SOURCE_ID = "imd_nowcast"
ENDPOINT = "https://api.imd.gov.in/api/v1/districtnowcast"


@dataclass
class Nowcast:
    id: str                # district_id + observation timestamp
    district_id: str
    district_name: str
    observation_time: str
    category: int          # IMD 1-19
    color: str             # green/yellow/orange/red
    severity: str
    message: str

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "district_id", "district_name", "observation_time",
            "category", "color", "severity", "message",
        ]


def _auth_headers() -> dict[str, str] | None:
    key = os.environ.get("IMD_API_KEY")
    token = os.environ.get("IMD_API_TOKEN")
    if not key or not token:
        return None
    return {"X-API-Key": key, "Authorization": f"Bearer {token}"}


def _parse_response(payload: dict, district_id: str, district_name: str) -> list[Nowcast]:
    """Accept a few likely envelope shapes."""
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = payload.get("data") or payload.get("nowcast") or [payload]
    else:
        rows = []

    out: list[Nowcast] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        obs_time = str(row.get("observation_time") or row.get("time") or row.get("issued_at") or "")
        try:
            category = int(row.get("category") or row.get("nowcast_category") or 0)
        except (TypeError, ValueError):
            category = 0
        color = str(row.get("color") or row.get("colour") or "green").lower()
        msg = str(row.get("message") or row.get("description") or "")

        out.append(Nowcast(
            id=f"{district_id}:{obs_time or 'latest'}",
            district_id=district_id,
            district_name=district_name,
            observation_time=obs_time,
            category=category,
            color=color,
            severity=SEVERITY_BY_COLOR.get(color, "Unknown"),
            message=msg,
        ))
    return out


def fetch(client: PoliteClient) -> list[Nowcast]:
    headers = _auth_headers()
    if headers is None:
        log.warning(
            "IMD_API_KEY / IMD_API_TOKEN not set — skipping imd_nowcast. "
            "Register at https://api.imd.gov.in/ and set both env vars."
        )
        return []

    client._session.headers.update(headers)

    all_rows: list[Nowcast] = []
    for district_id, district_name in DEFAULT_DISTRICTS.items():
        body = client.get(ENDPOINT, params={"id": district_id})
        if body is None:
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            log.warning("non-JSON nowcast response for district %s — skipping", district_id)
            continue
        all_rows.extend(_parse_response(payload, district_id, district_name))
        client.polite_sleep()

    log.info("fetched %d nowcast row(s) across %d district(s)", len(all_rows), len(DEFAULT_DISTRICTS))
    return all_rows


def key_for(record: Nowcast) -> str:
    return record.id
