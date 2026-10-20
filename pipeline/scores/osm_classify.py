"""Python port of the OSM tag -> feature classifier (js/data-fetcher.js).

Phase 0 of docs/PRECOMPUTE_PLAN.md. The browser classifies Overpass elements
into the ~135 feature keys that feed composite.compute_scores; the precompute
pipeline must classify a local .osm.pbf identically. This is a faithful,
side-effect-free port of CATEGORIES + matchesFeature + classifyElements, pinned
to the JS output by tests/test_classify_parity.py (golden/classify.json).

Semantics replicated exactly (js/data-fetcher.js:522-533):
  - a matcher value is a plain string (equality) or a JS regex (RegExp.test ==
    re.search — patterns carry their own ^...$ anchors; building:/.*/ matches
    any *non-empty* value);
  - a falsy/empty tag value never matches (``if (!actual) continue``);
  - an element increments EVERY feature key it matches (no first-match-wins);
  - worship religion subtypes are lowercased and counted separately.
"""
from __future__ import annotations

import re
from typing import Iterable

__all__ = [
    "FEATURES", "FEAT_TO_CAT", "RELEVANT_KEYS", "match_table",
    "classify_tags", "classify_elements", "assemble_data",
]


class _Rx:
    """A regex matcher that round-trips to its JS ``String(regex)`` form."""

    __slots__ = ("src", "rx")

    def __init__(self, src: str):
        self.src = src
        self.rx = re.compile(src)

    def __str__(self) -> str:          # mirrors JS String(/src/) == "/src/"
        return f"/{self.src}/"


def _rx(src: str) -> _Rx:
    return _Rx(src)


# (category, feature_key, {tag_key: matcher}) — transcribed from CATEGORIES
# (js/data-fetcher.js:106-320). Order matters only for match_table parity.
FEATURES: list[tuple[str, str, dict]] = [
    # food
    ("food", "restaurants", {"amenity": "restaurant"}),
    ("food", "cafes", {"amenity": "cafe"}),
    ("food", "fast_food", {"amenity": "fast_food"}),
    ("food", "bars", {"amenity": _rx("^(bar|pub)$")}),
    ("food", "food_court", {"amenity": "food_court"}),
    ("food", "ice_cream", {"amenity": "ice_cream"}),
    ("food", "bakery", {"shop": "bakery"}),
    ("food", "butcher", {"shop": "butcher"}),
    ("food", "confectionery", {"shop": "confectionery"}),
    ("food", "drinking_water", {"amenity": "drinking_water"}),
    # education
    ("education", "schools", {"amenity": "school"}),
    ("education", "colleges", {"amenity": "college"}),
    ("education", "universities", {"amenity": "university"}),
    ("education", "kindergartens", {"amenity": "kindergarten"}),
    ("education", "libraries", {"amenity": "library"}),
    ("education", "language_school", {"amenity": "language_school"}),
    ("education", "driving_school", {"amenity": "driving_school"}),
    ("education", "research", {"amenity": "research_institute"}),
    # healthcare
    ("healthcare", "hospitals", {"amenity": "hospital"}),
    ("healthcare", "clinics", {"amenity": _rx("^(clinic|doctors)$")}),
    ("healthcare", "pharmacies", {"amenity": "pharmacy"}),
    ("healthcare", "dentists", {"amenity": "dentist"}),
    ("healthcare", "veterinary", {"amenity": "veterinary"}),
    ("healthcare", "blood_bank", {"healthcare": "blood_bank"}),
    ("healthcare", "nursing_home", {"amenity": "nursing_home"}),
    ("healthcare", "lab", {"healthcare": "laboratory"}),
    ("healthcare", "optician", {"shop": "optician"}),
    ("healthcare", "alt_medicine", {"healthcare": "alternative"}),
    # finance
    ("finance", "banks", {"amenity": "bank"}),
    ("finance", "atms", {"amenity": "atm"}),
    ("finance", "exchange", {"amenity": "bureau_de_change"}),
    ("finance", "insurance", {"office": "insurance"}),
    ("finance", "microfinance", {"amenity": "microfinance"}),
    ("finance", "financial", {"office": "financial"}),
    ("finance", "tax", {"office": "tax"}),
    # shopping
    ("shopping", "mall", {"shop": "mall"}),
    ("shopping", "supermarket", {"shop": "supermarket"}),
    ("shopping", "convenience", {"shop": "convenience"}),
    ("shopping", "clothes", {"shop": "clothes"}),
    ("shopping", "electronics", {"shop": "electronics"}),
    ("shopping", "mobile", {"shop": "mobile_phone"}),
    ("shopping", "hardware", {"shop": _rx("^(hardware|doityourself)$")}),
    ("shopping", "furniture", {"shop": "furniture"}),
    ("shopping", "jewelry", {"shop": "jewelry"}),
    ("shopping", "books", {"shop": "books"}),
    ("shopping", "stationery", {"shop": "stationery"}),
    ("shopping", "department", {"shop": "department_store"}),
    ("shopping", "marketplace", {"amenity": "marketplace"}),
    ("shopping", "car_dealer", {"shop": "car"}),
    # transport
    ("transport", "bus_stop", {"highway": "bus_stop"}),
    ("transport", "railway", {"railway": _rx("^(station|halt)$")}),
    ("transport", "metro", {"station": "subway"}),
    ("transport", "taxi", {"amenity": "taxi"}),
    ("transport", "parking", {"amenity": "parking"}),
    ("transport", "bicycle_parking", {"amenity": "bicycle_parking"}),
    ("transport", "bicycle_rental", {"amenity": "bicycle_rental"}),
    ("transport", "fuel", {"amenity": "fuel"}),
    ("transport", "ev_charging", {"amenity": "charging_station"}),
    ("transport", "car_wash", {"amenity": "car_wash"}),
    ("transport", "car_repair", {"shop": "car_repair"}),
    ("transport", "auto_rickshaw", {"amenity": "auto_rickshaw_stand"}),
    # government
    ("government", "police", {"amenity": "police"}),
    ("government", "fire", {"amenity": "fire_station"}),
    ("government", "post_office", {"amenity": "post_office"}),
    ("government", "courthouse", {"amenity": "courthouse"}),
    ("government", "govt_office", {"office": "government"}),
    ("government", "embassy", {"amenity": "embassy"}),
    ("government", "community", {"amenity": "community_centre"}),
    ("government", "social", {"amenity": "social_facility"}),
    ("government", "toilets", {"amenity": "toilets"}),
    ("government", "recycling", {"amenity": _rx("^(recycling|waste_disposal)$")}),
    ("government", "townhall", {"amenity": "townhall"}),
    ("government", "prison", {"amenity": "prison"}),
    # leisure
    ("leisure", "parks", {"leisure": "park"}),
    ("leisure", "playground", {"leisure": "playground"}),
    ("leisure", "garden", {"leisure": "garden"}),
    ("leisure", "pitch", {"leisure": "pitch"}),
    ("leisure", "swimming", {"leisure": "swimming_pool"}),
    ("leisure", "gym", {"leisure": "fitness_centre"}),
    ("leisure", "sports_centre", {"leisure": "sports_centre"}),
    ("leisure", "stadium", {"leisure": "stadium"}),
    ("leisure", "golf", {"leisure": "golf_course"}),
    ("leisure", "water_park", {"leisure": "water_park"}),
    ("leisure", "dog_park", {"leisure": "dog_park"}),
    ("leisure", "nature_reserve", {"leisure": "nature_reserve"}),
    # entertainment
    ("entertainment", "cinema", {"amenity": "cinema"}),
    ("entertainment", "theatre", {"amenity": "theatre"}),
    ("entertainment", "museum", {"tourism": "museum"}),
    ("entertainment", "gallery", {"tourism": "gallery"}),
    ("entertainment", "nightclub", {"amenity": "nightclub"}),
    ("entertainment", "arcade", {"leisure": "amusement_arcade"}),
    ("entertainment", "theme_park", {"tourism": "theme_park"}),
    ("entertainment", "zoo", {"tourism": "zoo"}),
    ("entertainment", "monument", {"historic": _rx("^(monument|memorial)$")}),
    ("entertainment", "worship", {"amenity": "place_of_worship"}),
    # accommodation
    ("accommodation", "hotel", {"tourism": "hotel"}),
    ("accommodation", "guest_house", {"tourism": "guest_house"}),
    ("accommodation", "hostel", {"tourism": "hostel"}),
    ("accommodation", "motel", {"tourism": "motel"}),
    ("accommodation", "attraction", {"tourism": "attraction"}),
    ("accommodation", "viewpoint", {"tourism": "viewpoint"}),
    ("accommodation", "info", {"tourism": "information"}),
    ("accommodation", "picnic", {"tourism": "picnic_site"}),
    # landuse
    ("landuse", "residential_area", {"landuse": "residential"}),
    ("landuse", "commercial_area", {"landuse": "commercial"}),
    ("landuse", "industrial_area", {"landuse": "industrial"}),
    ("landuse", "retail_area", {"landuse": "retail"}),
    ("landuse", "buildings_total", {"building": _rx(".*")}),
    ("landuse", "res_buildings", {"building": _rx("^(residential|house|apartments|detached)$")}),
    ("landuse", "com_buildings", {"building": _rx("^(commercial|office|retail)$")}),
    ("landuse", "construction", {"landuse": "construction"}),
    ("landuse", "vacant", {"landuse": _rx("^(brownfield|greenfield)$")}),
    ("landuse", "cemetery", {"landuse": "cemetery"}),
    ("landuse", "military", {"landuse": "military"}),
    ("landuse", "farmland", {"landuse": _rx("^(farmland|orchard|vineyard)$")}),
    # infrastructure
    ("infrastructure", "street_lamps", {"highway": "street_lamp"}),
    ("infrastructure", "cell_tower", {"man_made": _rx("^(tower|mast)$")}),
    ("infrastructure", "power", {"power": _rx("^(substation|line|pole)$")}),
    ("infrastructure", "water_tower", {"man_made": _rx("^(water_tower|storage_tank)$")}),
    ("infrastructure", "bridge", {"man_made": "bridge"}),
    ("infrastructure", "roads", {"highway": _rx("^(primary|secondary|tertiary|residential|trunk)$")}),
    ("infrastructure", "footpath", {"highway": _rx("^(footway|path|pedestrian)$")}),
    ("infrastructure", "cycleway", {"highway": "cycleway"}),
    ("infrastructure", "water_body", {"natural": "water"}),
    ("infrastructure", "river", {"waterway": _rx("^(river|stream|canal)$")}),
    # business
    ("business", "offices", {"office": _rx("^(yes|company)$")}),
    ("business", "it_company", {"office": "it"}),
    ("business", "coworking", {"amenity": "coworking_space"}),
    ("business", "estate_agent", {"shop": "estate_agent"}),
    ("business", "lawyer", {"office": "lawyer"}),
    ("business", "accountant", {"office": "accountant"}),
    ("business", "beauty", {"shop": _rx("^(beauty|hairdresser)$")}),
    ("business", "laundry", {"shop": _rx("^(laundry|dry_cleaning)$")}),
    ("business", "photo", {"shop": "photo"}),
    ("business", "tailor", {"shop": "tailor"}),
]

FEAT_TO_CAT: dict[str, str] = {feat: cat for cat, feat, _ in FEATURES}

# Tag keys any feature looks at — a cheap pre-filter for the streaming counter
# (mirrors buildOverpassQuery's fetched key set, js/data-fetcher.js:496-517).
RELEVANT_KEYS: frozenset[str] = frozenset(
    k for _, _, match in FEATURES for k in match
)


def _matches(tags: dict, match: dict) -> bool:
    """Port of matchesFeature: any tag_key whose value matches wins."""
    for tag_key, expected in match.items():
        actual = tags.get(tag_key)
        if not actual:                       # falsy/empty never matches
            continue
        if isinstance(expected, _Rx):
            if expected.rx.search(actual):
                return True
        elif actual == expected:
            return True
    return False


def match_table() -> list:
    """The full match table in JS ``String(matcher)`` form — parity anchor."""
    return [
        [cat, feat, {k: str(v) for k, v in match.items()}]
        for cat, feat, match in FEATURES
    ]


def classify_tags(tags: dict) -> list[str]:
    """Feature keys an element with these tags matches (zero, one, or many)."""
    return [feat for _, feat, match in FEATURES if _matches(tags, match)]


def classify_elements(elements: Iterable[dict]) -> dict:
    """Port of classifyElements: {feat: {count, subTypes}} over all features.

    Used by the parity test; the streaming counter uses classify_tags directly.
    """
    results = {feat: {"count": 0, "subTypes": {}} for _, feat, _ in FEATURES}
    for el in elements:
        tags = el.get("tags") or {}
        for feat in classify_tags(tags):
            results[feat]["count"] += 1
            if feat == "worship" and tags.get("religion"):
                r = str(tags["religion"]).lower()
                results[feat]["subTypes"][r] = results[feat]["subTypes"].get(r, 0) + 1
    return results


def assemble_data(feature_counts: dict, worship_subtypes: dict, environment: dict) -> dict:
    """Build the exact {categories, environment} shape compute_scores consumes."""
    categories: dict = {}
    for cat, feat, _ in FEATURES:
        categories.setdefault(cat, {"features": {}})["features"][feat] = {
            "count": feature_counts.get(feat, 0),
        }
    categories["entertainment"]["features"]["worship"]["subTypes"] = dict(worship_subtypes or {})
    return {"categories": categories, "environment": environment or {}}
