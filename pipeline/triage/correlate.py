"""Decide which hazard events actually touch a region.

Two paths: geographic events (earthquakes, air stations) are point-tested
against the region bbox; name-only events (NDMA/IMD/GDACS) are matched against
the region gazetteer (place names in the text, an IMD district id encoded in the
event id, or a GDACS country name).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from . import regionmeta


@dataclass
class Match:
    event: object
    region_id: str
    matched_by: str   # "coords" | "name"


def _in_bbox(lat, lng, bbox, buffer=0.05) -> bool:
    return (bbox["west"] - buffer <= lng <= bbox["east"] + buffer
            and bbox["south"] - buffer <= lat <= bbox["north"] + buffer)


def _name_hit(event, meta) -> bool:
    hay = " ".join(str(x) for x in (event.headline, event.area_text)).lower()
    for tok in meta.names:
        if re.search(r"\b" + re.escape(tok) + r"\b", hay):
            return True
    # IMD feeds encode the district id as the "<id>:..." event-id prefix.
    if str(event.source).startswith("imd"):
        head = str(event.event_id).split(":", 1)[0]
        if head in meta.imd_district_ids or head in meta.imd_city_ids:
            return True
    # GDACS carries a country name in area_text.
    if event.source == "gdacs_disasters":
        for c in meta.country_names:
            if re.search(r"\b" + re.escape(c) + r"\b", hay):
                return True
    return False


def match_events(events, region_id: str) -> list:
    """Return the events (as Matches) that touch `region_id`."""
    meta = regionmeta.meta_for(region_id)
    bbox = regionmeta.bbox_dict(region_id)
    matches = []
    for e in events:
        if e.has_coords():
            if _in_bbox(e.lat, e.lng, bbox):
                matches.append(Match(e, region_id, "coords"))
        elif _name_hit(e, meta):
            matches.append(Match(e, region_id, "name"))
    return matches
