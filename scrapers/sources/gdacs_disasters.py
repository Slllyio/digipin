"""GDACS — Global Disaster Alert and Coordination System (UN/JRC/UN-OCHA).

Endpoint: https://www.gdacs.org/xml/rss.xml

RSS 2.0 feed of *current* global disasters across types: earthquake,
tropical cyclone, flood, volcano, drought, wildfire. GDACS is the
international standard for cross-border disaster coordination — its
alert score (Green/Orange/Red) is what UN-OCHA and the World Bank use
for emergency response triage.

For DigiPin this fills two gaps:
  - Flood awareness (we couldn't scrape CWC because their dashboard is
    a JS SPA — GDACS picks up the same events from satellite + ground
    sensor fusion)
  - International event awareness (a Bay of Bengal cyclone that will
    hit India in 36 hours appears here as soon as JTWC issues, well
    before it reaches IMD's domestic feed)

No auth, no rate limit hint. We're polite anyway.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.gdacs_disasters")

SOURCE_ID = "gdacs_disasters"
FEED_URL = "https://www.gdacs.org/xml/rss.xml"

# GDACS uses its own namespaces for event metadata.
NS = {
    "gdacs": "http://www.gdacs.org",
    "geo":   "http://www.w3.org/2003/01/geo/wgs84_pos#",
    "dc":    "http://purl.org/dc/elements/1.1/",
    "glide": "http://glidenumber.net",
}

# GDACS event types — short codes used in <gdacs:eventtype>.
EVENT_TYPE_LABELS = {
    "EQ":  "Earthquake",
    "TC":  "Tropical Cyclone",
    "FL":  "Flood",
    "VO":  "Volcano",
    "DR":  "Drought",
    "WF":  "Wildfire",
    "WG":  "Wind",
}


@dataclass
class Disaster:
    id: str                  # GDACS eventid (numeric)
    event_type: str          # EQ/TC/FL/VO/DR/WF/WG
    event_label: str         # human-readable label
    alert_score: float       # GDACS numeric score
    alert_level: str         # Green / Orange / Red
    title: str
    description: str
    country: str
    published_utc: str
    latitude: float | None = None
    longitude: float | None = None
    url: str = ""
    glide_number: str = ""
    population_affected: str = ""
    tags: list[str] = field(default_factory=list)

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "event_type", "event_label", "alert_score", "alert_level",
            "title", "description", "country", "published_utc",
            "latitude", "longitude", "url", "glide_number",
            "population_affected", "tags",
        ]


def _text(elem: ET.Element | None) -> str:
    return (elem.text or "").strip() if elem is not None else ""


def _float_or_none(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _strip_html(text: str) -> str:
    """Description sometimes contains inline HTML; strip it for storage."""
    return re.sub(r"<[^>]+>", " ", text).strip()


def fetch(client: PoliteClient) -> list[Disaster]:
    body = client.get(FEED_URL)
    if body is None:
        log.error("could not fetch GDACS RSS feed")
        return []

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        log.error("GDACS RSS parse error: %s", e)
        return []

    disasters: list[Disaster] = []
    for item in root.findall(".//item"):
        event_id = _text(item.find("gdacs:eventid", NS))
        if not event_id:
            continue

        event_type_raw = _text(item.find("gdacs:eventtype", NS)).upper()
        title = _text(item.find("title"))
        desc = _strip_html(_text(item.find("description")))
        country = _text(item.find("gdacs:country", NS))
        pub = _text(item.find("pubDate"))
        link = _text(item.find("link"))
        glide = _text(item.find("glide:number", NS))
        pop_affected = _text(item.find("gdacs:population", NS))

        alert_score = _float_or_none(_text(item.find("gdacs:alertscore", NS))) or 0.0
        alert_level = _text(item.find("gdacs:alertlevel", NS)) or "Green"

        lat = _float_or_none(_text(item.find("geo:lat", NS)))
        lng = _float_or_none(_text(item.find("geo:long", NS)))

        # Optional category tags supplied as <category> children
        tags = [t.text.strip() for t in item.findall("category") if t.text]

        disasters.append(Disaster(
            id=event_id,
            event_type=event_type_raw,
            event_label=EVENT_TYPE_LABELS.get(event_type_raw, event_type_raw or "Other"),
            alert_score=alert_score,
            alert_level=alert_level,
            title=title,
            description=desc,
            country=country,
            published_utc=pub,
            latitude=lat,
            longitude=lng,
            url=link,
            glide_number=glide,
            population_affected=pop_affected,
            tags=tags,
        ))

    log.info("GDACS: parsed %d active disaster(s)", len(disasters))
    return disasters


def key_for(record: Disaster) -> str:
    return record.id
