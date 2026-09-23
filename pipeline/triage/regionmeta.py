"""Region gazetteer for name-based hazard matching.

`pipeline/_lib/regions.py` stores only bounding boxes — it has no display names
or district ids. The name-based feeds (NDMA, IMD, GDACS) reference places by
text (district names in a headline, an IMD district id, a GDACS country), so
triage needs a small per-region gazetteer to decide whether a non-geographic
alert touches the region. Extend `_META` when onboarding a new pilot city.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from pipeline._lib import regions


@dataclass(frozen=True)
class RegionMeta:
    region_id: str
    # Lowercase place tokens matched with word boundaries against alert text.
    names: tuple = ()
    imd_district_ids: tuple = ()
    imd_city_ids: tuple = ()
    country_names: tuple = ("india",)


_META = {
    "indore_pilot": RegionMeta(
        region_id="indore_pilot",
        names=("indore", "madhya pradesh", "mp", "pithampur", "mhow", "dewas"),
        imd_district_ids=("423",),
        imd_city_ids=("42667",),
        country_names=("india",),
    ),
}


def meta_for(region_id: str) -> RegionMeta:
    """Gazetteer for a region; an empty-names fallback (geo matching only) if unknown."""
    return _META.get(region_id) or RegionMeta(region_id=region_id)


def bbox_dict(region_id: str) -> dict:
    """Region bounding box as {west,south,east,north} (matches coverage.json)."""
    w, s, e, n = regions.bbox_for(region_id)
    return {"west": w, "south": s, "east": e, "north": n}
