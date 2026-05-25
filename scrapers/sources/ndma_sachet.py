"""NDMA SACHET — All-India CAP disaster alerts.

The feed is published as an RSS 2.0 wrapper around CAP (Common Alerting
Protocol) v1.2 entries. We parse just the fields the portal needs to
surface to users: severity, area, headline, validity window, and the
upstream link for citizens who want the full CAP XML.

Why CAP-over-RSS instead of CAP-direct: the per-alert XML URLs in the feed
(`FetchXMLFile?identifier=...`) return the full CAP record, but the RSS
already includes enough fields to power a banner / DISHA-context line.
A separate `--deep` mode could be added later to follow each link and
extract polygon geometries when we need spatial filtering.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

from ..lib.http import PoliteClient

log = logging.getLogger("scrapers.ndma_sachet")

SOURCE_ID = "ndma_sachet"
FEED_URL = "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml"

# RSS 2.0 fields are unnamespaced; CAP namespace appears in some extensions.
NS = {"cap": "urn:oasis:names:tc:emergency:cap:1.2"}


@dataclass
class Alert:
    """One CAP/RSS alert item."""
    id: str
    headline: str
    description: str
    area: str
    published_utc: str
    cap_xml_url: str
    severity: str = ""
    category: str = ""
    tags: list[str] = field(default_factory=list)

    @staticmethod
    def csv_fields() -> list[str]:
        return [
            "id", "headline", "area", "severity", "category",
            "published_utc", "cap_xml_url", "description", "tags",
        ]


def _text(elem: ET.Element | None) -> str:
    return (elem.text or "").strip() if elem is not None else ""


def _identifier_from_link(link: str) -> str:
    m = re.search(r"identifier=([\w-]+)", link)
    return m.group(1) if m else link


def _infer_severity(headline: str, description: str) -> str:
    """RSS feed often omits CAP severity. Heuristic from text — keep
    it transparent in the docstring so consumers know it is best-effort."""
    blob = f"{headline} {description}".lower()
    if any(w in blob for w in ("extreme", "red alert", "evacuat", "very severe")):
        return "Extreme"
    if any(w in blob for w in ("severe", "heavy", "intense", "warning", "orange alert")):
        return "Severe"
    if any(w in blob for w in ("moderate", "watch", "yellow alert")):
        return "Moderate"
    return "Minor"


def _infer_category(headline: str) -> str:
    """RSS lacks CAP <category>. Derive from headline keywords."""
    h = headline.lower()
    if any(w in h for w in ("thunderstorm", "lightning", "rain", "monsoon", "shower")):
        return "Met-Storm"
    if any(w in h for w in ("heatwave", "heat wave", "temperature")):
        return "Met-Heat"
    if any(w in h for w in ("cyclone", "depression", "low pressure")):
        return "Met-Cyclone"
    if any(w in h for w in ("flood", "waterlog", "deluge")):
        return "Met-Flood"
    if any(w in h for w in ("earthquake", "seismic", "tremor")):
        return "Geo-Earthquake"
    if any(w in h for w in ("landslide", "rockfall")):
        return "Geo-Landslide"
    if "fire" in h:
        return "Fire"
    return "Other"


def fetch(client: PoliteClient) -> list[Alert]:
    """Pull the current All-India feed and parse into Alert records."""
    body = client.get(FEED_URL)
    if body is None:
        log.error("could not fetch SACHET RSS feed")
        return []

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        log.error("RSS parse error: %s", e)
        return []

    alerts: list[Alert] = []
    for item in root.findall(".//item"):
        link = _text(item.find("link"))
        headline = _text(item.find("title"))
        description = _text(item.find("description"))
        pub_date = _text(item.find("pubDate"))

        # 'area' lives in the CAP-extended element or, as a fallback, can be
        # parsed out of description / headline. The RSS in the wild puts the
        # district/state list inside <description> as plain text after the
        # headline summary; that is good enough for the portal banner.
        area = ""
        # Try CAP extension first (some publishers include it)
        area_elem = item.find("cap:areaDesc", NS)
        if area_elem is not None and area_elem.text:
            area = area_elem.text.strip()

        identifier = _identifier_from_link(link)
        if not identifier:
            continue

        alerts.append(Alert(
            id=identifier,
            headline=headline,
            description=description,
            area=area,
            published_utc=pub_date,
            cap_xml_url=link,
            severity=_infer_severity(headline, description),
            category=_infer_category(headline),
        ))

    log.info("parsed %s alert(s) from SACHET RSS", len(alerts))
    return alerts


def key_for(record: Alert) -> str:
    return record.id
