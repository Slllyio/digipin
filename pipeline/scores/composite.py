"""Python port of the composite intelligence scores (js/data-fetcher.js).

Phase 0 of docs/PRECOMPUTE_PLAN.md — the ~24 per-cell intelligence scores the
browser computes from OSM feature counts. Faithful, side-effect-free port of
``computeScores`` and its helpers; pinned to the JS output by
tests/test_composite_parity.py. See pipeline/scores/README.md.

Input shape (mirrors what DataFetcher.fetchAllFeatures produces):
    data = {
      "categories": { "<cat>": { "features": { "<feat>": { "count": int,
                                                           "subTypes": {...} }}}},
      "environment": { "populationDensity": { "personsPerHectare": float },
                       "elevation": { "isLowLying": bool, "relative": float } },
    }
"""
from __future__ import annotations

import math

from pipeline.scores.growth import js_round, norm_log

__all__ = [
    "compute_scores", "religious_diversity_score", "compute_safety_score",
    "compute_quietness_score", "compute_population_score", "compute_flood_risk",
]


def _get(data: dict, cat: str, feat: str):
    """data.categories[cat].features[feat].count, defaulting to 0."""
    feature = (((data.get("categories") or {}).get(cat) or {}).get("features") or {}).get(feat) or {}
    return feature.get("count") or 0


def religious_diversity_score(sub_types, total_count):
    """Shannon evenness x richness, with a discounted-count fallback."""
    counts = [c for c in (sub_types or {}).values() if c > 0]
    tagged_total = sum(counts)
    if tagged_total == 0:
        return js_round(norm_log(total_count, 20) * 0.5)
    richness = min(len(counts) / 4, 1)
    if len(counts) == 1:
        return js_round(100 * (0.4 * richness) * min(1, tagged_total / 3))
    H = 0.0
    for c in counts:
        p = c / tagged_total
        H -= p * math.log(p)
    evenness = H / math.log(len(counts))
    return js_round(100 * (0.6 * evenness + 0.4 * richness))


def compute_safety_score(data: dict) -> int:
    g = lambda cat, feat: _get(data, cat, feat)  # noqa: E731
    lamps = g("infrastructure", "street_lamps")
    police = g("government", "police")
    fire = g("government", "fire")
    hospitals = g("healthcare", "hospitals")
    footpaths = g("infrastructure", "footpath")
    buildings = g("landuse", "buildings_total")
    industrial = g("landuse", "industrial_area")
    nightclubs = g("entertainment", "nightclub")

    score = norm_log(lamps * 2 + police * 15 + fire * 12 + hospitals * 5, 100)
    score += min(15, norm_log(buildings * 0.1 + footpaths * 2, 30))
    score -= industrial * 8
    score -= nightclubs * 3
    return max(0, min(100, js_round(score)))


def compute_quietness_score(data: dict) -> int:
    g = lambda cat, feat: _get(data, cat, feat)  # noqa: E731
    noise = 0
    noise += g("infrastructure", "roads") * 0.3
    noise += g("transport", "bus_stop") * 4
    noise += g("transport", "railway") * 15
    noise += g("transport", "metro") * 8
    noise += g("landuse", "industrial_area") * 12
    noise += g("entertainment", "nightclub") * 6
    noise += g("shopping", "marketplace") * 5
    noise += g("transport", "fuel") * 3
    noise += g("entertainment", "cinema") * 2
    noise -= g("leisure", "parks") * 3
    noise -= g("leisure", "garden") * 2
    noise -= g("leisure", "nature_reserve") * 5
    quietness = 100 - norm_log(max(0, noise), 80)
    return max(0, min(100, quietness))


def compute_population_score(data: dict) -> int:
    pop = (data.get("environment") or {}).get("populationDensity")
    if pop and (pop.get("personsPerHectare") or 0) > 0:
        return norm_log(pop["personsPerHectare"], 500)
    g = lambda cat, feat: _get(data, cat, feat)  # noqa: E731
    res_buildings = g("landuse", "res_buildings")
    total_buildings = g("landuse", "buildings_total")
    convenience = g("shopping", "convenience")
    res_areas = g("landuse", "residential_area")
    return norm_log(res_buildings * 5 + total_buildings * 0.3 + convenience * 8 + res_areas * 10, 200)


def compute_flood_risk(data: dict) -> int:
    g = lambda cat, feat: _get(data, cat, feat)  # noqa: E731
    elev = (data.get("environment") or {}).get("elevation")
    risk = 30
    if elev and isinstance(elev, dict):
        rel = elev.get("relative")
        if elev.get("isLowLying"):
            risk += 25
        elif rel is not None and rel < 0:
            risk += 10
        elif rel is not None and rel > 5:
            risk -= 15
    risk += g("infrastructure", "water_body") * 8
    risk += g("infrastructure", "river") * 12
    risk -= g("infrastructure", "bridge") * 5
    risk -= g("infrastructure", "power") * 2
    risk += g("landuse", "industrial_area") * 5
    return max(0, min(100, js_round(risk)))


def compute_scores(data: dict) -> dict:
    """The ~24 intelligence scores keyed by id -> {label, value} (0..100)."""
    cats = data.get("categories") or {}
    g = lambda cat, feat: _get(data, cat, feat)  # noqa: E731

    scores = {
        "walkability": {"label": "Walkability Score", "value": norm_log(
            g("food", "restaurants") * 2 + g("food", "cafes") * 2
            + g("shopping", "convenience") * 2 + g("shopping", "supermarket") * 2
            + g("transport", "bus_stop") * 3 + g("leisure", "parks") * 3
            + g("infrastructure", "footpath") * 1.5 + g("government", "toilets") * 2, 80)},
        "safety": {"label": "Safety Index", "value": compute_safety_score(data)},
        "green": {"label": "Green Index", "value": norm_log(
            g("leisure", "parks") * 8 + g("leisure", "garden") * 5
            + g("leisure", "playground") * 3 + g("infrastructure", "water_body") * 4
            + g("leisure", "nature_reserve") * 15 + g("leisure", "dog_park") * 3, 80)},
        "connectivity": {"label": "Connectivity Score", "value": norm_log(
            g("transport", "bus_stop") * 3 + g("transport", "metro") * 20
            + g("transport", "railway") * 15 + g("transport", "parking") * 2
            + g("transport", "bicycle_rental") * 5 + g("infrastructure", "roads") * 0.3, 100)},
        "commercial": {"label": "Commercial Vibrancy", "value": norm_log(
            g("shopping", "mall") * 15 + g("shopping", "supermarket") * 5
            + g("food", "restaurants") * 2 + g("business", "offices") * 3
            + g("shopping", "marketplace") * 8 + g("shopping", "department") * 10
            + g("shopping", "convenience") * 1, 120)},
        "education_score": {"label": "Education Index", "value": norm_log(
            g("education", "schools") * 5 + g("education", "colleges") * 10
            + g("education", "universities") * 20 + g("education", "libraries") * 8
            + g("education", "kindergartens") * 3, 80)},
        "healthcare_access": {"label": "Healthcare Access", "value": norm_log(
            g("healthcare", "hospitals") * 12 + g("healthcare", "clinics") * 3
            + g("healthcare", "pharmacies") * 1.5 + g("healthcare", "lab") * 5
            + g("healthcare", "dentists") * 3 + g("healthcare", "nursing_home") * 8, 100)},
        "entertainment_score": {"label": "Entertainment Score", "value": norm_log(
            g("entertainment", "cinema") * 8 + g("leisure", "parks") * 3
            + g("leisure", "gym") * 4 + g("entertainment", "nightclub") * 6
            + g("entertainment", "museum") * 10 + g("entertainment", "theatre") * 8
            + g("leisure", "sports_centre") * 5, 80)},
        "livability": {"label": "Livability Index", "value": 0},
        "investment": {"label": "Investment Potential", "value": norm_log(
            g("landuse", "construction") * 12 + g("landuse", "vacant") * 8
            + g("transport", "bus_stop") * 2 + g("transport", "metro") * 20
            + g("business", "coworking") * 8 + g("business", "estate_agent") * 10, 100)},
        "tourism": {"label": "Tourism Appeal", "value": norm_log(
            g("accommodation", "hotel") * 5 + g("entertainment", "monument") * 8
            + g("entertainment", "museum") * 10 + g("accommodation", "attraction") * 8
            + g("food", "restaurants") * 1 + g("accommodation", "guest_house") * 3
            + g("entertainment", "worship") * 2, 80)},
        "infra_maturity": {"label": "Infrastructure Maturity", "value": norm_log(
            g("infrastructure", "street_lamps") * 0.5 + g("infrastructure", "cell_tower") * 8
            + g("infrastructure", "power") * 5 + g("government", "post_office") * 8
            + g("infrastructure", "roads") * 0.2 + g("infrastructure", "bridge") * 10, 100)},
        "noise_estimate": {"label": "Quietness (Higher=Better)", "value": compute_quietness_score(data)},
        "population_proxy": {"label": "Population Density", "value": compute_population_score(data)},
        "food_diversity": {"label": "Food Diversity", "value": norm_log(
            g("food", "restaurants") + g("food", "cafes") + g("food", "fast_food")
            + g("food", "bakery") + g("food", "bars") + g("food", "ice_cream")
            + g("food", "confectionery") + g("food", "butcher"), 40)},
        "religious_diversity": {"label": "Religious Diversity", "value": (lambda w: religious_diversity_score(
            w.get("subTypes") if w else None, (w.get("count") if w else 0) or 0))(
            ((cats.get("entertainment") or {}).get("features") or {}).get("worship"))},
        "public_service": {"label": "Public Service Access", "value": norm_log(
            g("government", "post_office") * 8 + g("government", "govt_office") * 8
            + g("government", "community") * 5 + g("government", "toilets") * 3
            + g("government", "townhall") * 10 + g("government", "social") * 5, 60)},
        "real_estate_growth": {"label": "Real Estate Growth", "value": norm_log(
            g("landuse", "construction") * 15 + g("landuse", "vacant") * 10
            + g("business", "estate_agent") * 12 + g("transport", "ev_charging") * 8, 80)},
        "digital_readiness": {"label": "Digital Readiness", "value": norm_log(
            g("infrastructure", "cell_tower") * 8 + g("business", "coworking") * 12
            + g("business", "it_company") * 10 + g("transport", "ev_charging") * 6
            + g("shopping", "electronics") * 3 + g("shopping", "mobile") * 3, 80)},
        "flood_risk": {"label": "Flood Risk (Higher=Riskier)", "value": compute_flood_risk(data)},
    }

    liv_weights = {
        "walkability": 2, "safety": 3, "green": 2, "connectivity": 1.5,
        "healthcare_access": 2, "noise_estimate": 1.5, "food_diversity": 1,
    }
    liv_sum = 0.0
    liv_w = 0.0
    for k, w in liv_weights.items():
        liv_sum += ((scores.get(k) or {}).get("value") or 0) * w
        liv_w += w
    scores["livability"]["value"] = js_round(liv_sum / liv_w)

    return scores
