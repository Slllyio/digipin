"""Count OSM features per DIGIPIN cell from a local .osm.pbf (A2).

Replaces the stubbed feature-counter seam in score_grid.py with the real thing.
Two stages, matching docs/PRECOMPUTE_PLAN.md:

1. **Bin pass** (`build_bins`) — one streaming pass (pyosmium) over a
   bbox-clipped extract; classify each node/way with osm_classify and accumulate
   its matched feature keys into a sparse bin at DIGIPIN level-8 (~15 m)
   integer indices. A way's representative point is its node-bbox centre, to
   match Overpass ``out center``.

2. **Kernel pass** (`make_feature_counter`) — returns the FeatureCounter closure
   score_grid expects: for a cell, sum every fine bin whose centre lies within
   ``radius_m`` (default 400 m) of the cell centre. This reproduces the app's
   ``(around:400,lat,lng)`` disc semantics — a cell-rectangle count (~6 ha) would
   deflate every ``norm_log`` score calibrated for a ~50 ha disc.

Known v1 gap: relations (multipolygon parks/rivers/landuse) are not counted —
nodes + ways only. Measured, not assumed, by scripts/spot_check_parity.py.
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Callable, Optional

import osmium

from pipeline._lib import digipin
from pipeline.scores import osm_classify

_M_PER_DEG_LAT = 111_320.0
FINE_LEVEL = 8  # ~15 m bins


class Bins:
    """Sparse level-8 bins: (row, col) -> feature Counter / worship Counter."""

    __slots__ = ("fine_level", "n", "feat", "worship", "n_elements")

    def __init__(self, fine_level: int = FINE_LEVEL):
        self.fine_level = fine_level
        self.n = 4 ** fine_level
        self.feat: dict[tuple[int, int], Counter] = defaultdict(Counter)
        self.worship: dict[tuple[int, int], Counter] = defaultdict(Counter)
        self.n_elements = 0


def _fine_index(lat: float, lon: float, n: int) -> tuple[int, int]:
    b = digipin.BOUNDS
    r = math.floor((lat - b["minLat"]) / ((b["maxLat"] - b["minLat"]) / n))
    c = math.floor((lon - b["minLon"]) / ((b["maxLon"] - b["minLon"]) / n))
    return r, c


def _add(bins: Bins, lat: float, lon: float, tags: dict) -> None:
    if not (osm_classify.RELEVANT_KEYS & tags.keys()):
        return
    feats = osm_classify.classify_tags(tags)
    if not feats:
        return
    idx = _fine_index(lat, lon, bins.n)
    bins.feat[idx].update(feats)
    bins.n_elements += 1
    if "worship" in feats and tags.get("religion"):
        bins.worship[idx][str(tags["religion"]).lower()] += 1


def build_bins(pbf_path: str, fine_level: int = FINE_LEVEL) -> Bins:
    """Stream the extract once, binning classified nodes + ways at ``fine_level``."""
    bins = Bins(fine_level)
    fp = osmium.FileProcessor(pbf_path).with_locations()
    for o in fp:
        if o.is_node():
            loc = o.location
            if not loc.valid():
                continue
            lat, lon = loc.lat, loc.lon
        elif o.is_way():
            lats = [nd.location.lat for nd in o.nodes if nd.location.valid()]
            lons = [nd.location.lon for nd in o.nodes if nd.location.valid()]
            if not lats:
                continue
            lat = (min(lats) + max(lats)) / 2.0   # node-bbox centre (out center)
            lon = (min(lons) + max(lons)) / 2.0
        else:
            continue  # relations: v1 gap (measured by the spot check)
        tags = dict(o.tags)
        if tags:
            _add(bins, lat, lon, tags)
    return bins


def _disc_offsets(fine_level: int, lat: float, radius_m: float) -> list[tuple[int, int]]:
    """Fine-cell (dr, dc) offsets whose centre is within radius_m, at this latitude."""
    b = digipin.BOUNDS
    n = 4 ** fine_level
    lat_step_m = (b["maxLat"] - b["minLat"]) / n * _M_PER_DEG_LAT
    lon_step_m = (b["maxLon"] - b["minLon"]) / n * _M_PER_DEG_LAT * math.cos(math.radians(lat))
    rr = math.ceil(radius_m / lat_step_m)
    cr = math.ceil(radius_m / lon_step_m)
    r2 = radius_m * radius_m
    offs = []
    for dr in range(-rr, rr + 1):
        dy = dr * lat_step_m
        for dc in range(-cr, cr + 1):
            dx = dc * lon_step_m
            if dy * dy + dx * dx <= r2:
                offs.append((dr, dc))
    return offs


def make_feature_counter(
    bins: Bins,
    radius_m: float = 400.0,
    env_sampler: Optional[Callable[[dict], dict]] = None,
) -> Callable[[dict], dict]:
    """Return a FeatureCounter: cell -> {categories, environment} for compute_scores.

    Disc-kernel sum of fine bins within ``radius_m`` of the cell centre. The
    offset list depends on latitude (longitude metres/degree), cached per
    rounded-degree band — fine for a single city.
    """
    _offset_cache: dict[int, list] = {}

    def counter(cell: dict) -> dict:
        center = cell["center"]
        lat, lng = center["lat"], center["lng"]
        band = round(lat)
        offs = _offset_cache.get(band)
        if offs is None:
            offs = _disc_offsets(bins.fine_level, lat, radius_m)
            _offset_cache[band] = offs

        r0, c0 = _fine_index(lat, lng, bins.n)
        feat_counts: Counter = Counter()
        worship: Counter = Counter()
        for dr, dc in offs:
            key = (r0 + dr, c0 + dc)
            fb = bins.feat.get(key)
            if fb:
                feat_counts.update(fb)
                wb = bins.worship.get(key)
                if wb:
                    worship.update(wb)

        env = env_sampler(cell) if env_sampler is not None else {}
        return osm_classify.assemble_data(feat_counts, worship, env)

    return counter
