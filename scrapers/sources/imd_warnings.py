"""IMD — 5-day district color-coded warnings.

Endpoint: https://api.imd.gov.in/api/v1/districtwarning?id=<district_id>

Auth (REQUIRED — apparent from live probing 2026-05-24):
    X-API-Key:      <your API key from api.imd.gov.in>
    Authorization:  Bearer <your JWT from api.imd.gov.in>

The official docs page advertises "free, open access" — but in practice
the endpoint returns 401 'API key missing'. The discrepancy is captured
verbatim in scrapers/README.md so future maintainers know the doc is
stale, not their environment.

Registration:
  1. https://api.imd.gov.in/  →  Create Account  →  verify email
  2. The portal issues an X-API-Key and a JWT bearer token.
  3. Set as environment variables (or GitHub Actions secrets):
       export IMD_API_KEY=...
       export IMD_API_TOKEN=...
  4. Re-run: `python -m scrapers.cli imd_warnings`

When the env vars are absent, the scraper logs a clear warning and
returns an empty list rather than crashing — so the cron workflow
keeps refreshing the other sources (NDMA SACHET) without interruption.

Default districts (for the Indore pilot + a few hand-picked MP/MH/DL
cells). Override with --districts on the CLI when scraping elsewhere.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.imd_warnings")

SOURCE_ID = "imd_warnings"
ENDPOINT = "https://api.imd.gov.in/api/v1/districtwarning"

# District IDs follow IMD's internal numbering (NOT Census codes).
# Below is a small hand-curated set for the DigiPin pilot. Expand by
# inspecting district dropdowns at https://mausam.imd.gov.in/.
DEFAULT_DISTRICTS: dict[str, str] = {
    "423": "Indore (MP)",
    "424": "Bhopal (MP)",
    "425": "Ujjain (MP)",
    "430": "Gwalior (MP)",
    "501": "Mumbai City (MH)",
    "502": "Mumbai Suburban (MH)",
    "071": "New Delhi (DL)",
    "069": "Central Delhi (DL)",
    "555": "Bengaluru Urban (KA)",
    "640": "Hyderabad (TG)",
}

# IMD warning color → severity ladder (matches the public legend).
SEVERITY_BY_COLOR = {
    "green":  "No Warning",
    "yellow": "Watch",
    "orange": "Alert",
    "red":    "Warning",
}


@dataclass
class Warning:
    id: str
    district_id: str
    district_name: str
    day_offset: int            # 0 = today, 1 = tomorrow, ...
    valid_date: str
    color: str
    severity: str
    description: str
    hazards: list[str] = field(default_factory=list)

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "district_id", "district_name", "day_offset",
            "valid_date", "color", "severity", "description", "hazards",
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


def _parse_response(payload: dict, district_id: str, district_name: str) -> list[Warning]:
    """The exact shape is documented in the IMD API reference but the live
    JSON keys can vary. We accept either a top-level list or a {data: [...]}
    envelope, and we pull warnings by common key names."""
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = payload.get("data") or payload.get("warnings") or payload.get("forecast") or []
    else:
        rows = []

    warnings: list[Warning] = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        day_offset = int(row.get("day_offset") or row.get("day") or i)
        valid = str(row.get("valid_date") or row.get("date") or "")
        color = str(row.get("color") or row.get("colour") or "green").lower()
        desc = str(row.get("description") or row.get("message") or row.get("warning_message") or "")
        hazards_raw = row.get("hazards") or row.get("warning_codes") or []
        if isinstance(hazards_raw, str):
            hazards = [h.strip() for h in hazards_raw.split(",") if h.strip()]
        elif isinstance(hazards_raw, list):
            hazards = [str(h) for h in hazards_raw]
        else:
            hazards = []

        warnings.append(Warning(
            id=f"{district_id}:{valid or day_offset}",
            district_id=district_id,
            district_name=district_name,
            day_offset=day_offset,
            valid_date=valid,
            color=color,
            severity=SEVERITY_BY_COLOR.get(color, "Unknown"),
            description=desc,
            hazards=hazards,
        ))
    return warnings


def fetch(client: PoliteClient) -> list[Warning]:
    headers = _auth_headers()
    if headers is None:
        log.warning(
            "IMD_API_KEY / IMD_API_TOKEN not set — skipping imd_warnings. "
            "Register at https://api.imd.gov.in/ and set both env vars to enable."
        )
        return []

    # Inject the auth headers into the session for this run.
    client._session.headers.update(headers)

    all_warnings: list[Warning] = []
    for district_id, district_name in DEFAULT_DISTRICTS.items():
        body = client.get(ENDPOINT, params={"id": district_id})
        if body is None:
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            log.warning("non-JSON response for district %s — skipping", district_id)
            continue
        all_warnings.extend(_parse_response(payload, district_id, district_name))
        client.polite_sleep()

    log.info("fetched %d warning row(s) across %d district(s)", len(all_warnings), len(DEFAULT_DISTRICTS))
    return all_warnings


def key_for(record: Warning) -> str:
    return record.id
