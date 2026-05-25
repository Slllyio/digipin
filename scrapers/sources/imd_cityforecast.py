"""IMD — 7-day city forecast.

Endpoint: https://api.imd.gov.in/api/v1/cityforecast
   (or)   https://api.imd.gov.in/api/v1/cityforecastloc with lat/lng

Auth (REQUIRED — see scrapers/sources/imd_warnings.py for the registration
flow). Same env vars: IMD_API_KEY + IMD_API_TOKEN.

Default cities cover the DigiPin pilot (Indore + a handful of major
metros). Each city has a small numeric ID assigned by IMD; override
with --cities on the CLI to scrape elsewhere.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.imd_cityforecast")

SOURCE_ID = "imd_cityforecast"
ENDPOINT = "https://api.imd.gov.in/api/v1/cityforecast"

# IMD's city IDs — hand-curated from the dropdown at
# https://city.imd.gov.in/citywx/city_weather.php (the dropdown's <option
# value> attribute carries the ID). These should be re-verified after
# your registration completes — IMD has occasionally renumbered cities.
DEFAULT_CITIES: dict[str, str] = {
    "42667": "Indore",
    "42754": "Bhopal",
    "42647": "Jaipur",
    "43003": "Mumbai",
    "42182": "New Delhi",
    "43295": "Bengaluru",
    "43128": "Hyderabad",
    "43279": "Chennai",
    "42809": "Kolkata",
}


@dataclass
class Forecast:
    id: str
    city_id: str
    city_name: str
    valid_date: str
    day_offset: int
    temperature_max_c: float | None = None
    temperature_min_c: float | None = None
    humidity_max_pct: float | None = None
    humidity_min_pct: float | None = None
    rainfall_mm: float | None = None
    weather_description: str = ""
    sunrise: str = ""
    sunset: str = ""

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "city_id", "city_name", "valid_date", "day_offset",
            "temperature_max_c", "temperature_min_c",
            "humidity_max_pct", "humidity_min_pct",
            "rainfall_mm", "weather_description", "sunrise", "sunset",
        ]


def _auth_headers() -> dict[str, str] | None:
    key = os.environ.get("IMD_API_KEY")
    token = os.environ.get("IMD_API_TOKEN")
    if not key or not token:
        return None
    return {
        "X-API-Key": key,
        "Authorization": f"Bearer {token}",
    }


def _to_float(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_response(payload: dict, city_id: str, city_name: str) -> list[Forecast]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = payload.get("data") or payload.get("forecast") or payload.get("days") or []
    else:
        rows = []

    forecasts: list[Forecast] = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        valid = str(row.get("valid_date") or row.get("date") or "")
        day_offset = int(row.get("day_offset") or row.get("day") or i)
        forecasts.append(Forecast(
            id=f"{city_id}:{valid or day_offset}",
            city_id=city_id,
            city_name=city_name,
            valid_date=valid,
            day_offset=day_offset,
            temperature_max_c=_to_float(row.get("temp_max") or row.get("temperature_max") or row.get("max_temp")),
            temperature_min_c=_to_float(row.get("temp_min") or row.get("temperature_min") or row.get("min_temp")),
            humidity_max_pct=_to_float(row.get("humidity_max") or row.get("rh_max")),
            humidity_min_pct=_to_float(row.get("humidity_min") or row.get("rh_min")),
            rainfall_mm=_to_float(row.get("rainfall") or row.get("rain") or row.get("precip")),
            weather_description=str(row.get("description") or row.get("weather") or ""),
            sunrise=str(row.get("sunrise") or ""),
            sunset=str(row.get("sunset") or ""),
        ))
    return forecasts


def fetch(client: PoliteClient) -> list[Forecast]:
    headers = _auth_headers()
    if headers is None:
        log.warning(
            "IMD_API_KEY / IMD_API_TOKEN not set — skipping imd_cityforecast. "
            "Register at https://api.imd.gov.in/ and set both env vars to enable."
        )
        return []

    client._session.headers.update(headers)

    all_forecasts: list[Forecast] = []
    for city_id, city_name in DEFAULT_CITIES.items():
        body = client.get(ENDPOINT, params={"id": city_id})
        if body is None:
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            log.warning("non-JSON response for city %s — skipping", city_id)
            continue
        all_forecasts.extend(_parse_response(payload, city_id, city_name))
        client.polite_sleep()

    log.info("fetched %d forecast row(s) across %d cit(ies)", len(all_forecasts), len(DEFAULT_CITIES))
    return all_forecasts


def key_for(record: Forecast) -> str:
    return record.id
