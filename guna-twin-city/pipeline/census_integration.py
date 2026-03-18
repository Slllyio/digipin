"""
Census 2011 Integration for Guna City
======================================
Hardcoded Census 2011 data for Guna district/city (public government data).
Generates:
  - data/vectors/census_guna.json  (structured census + ward estimates + indicators)
  - Enriches ward boundaries GeoJSON if available

Usage:
    python census_integration.py
"""

import json
import logging
import math
import sys
from pathlib import Path

from config import CITY_NAME, VECTOR_DIR, BBOX_CITY

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Census 2011 — Guna City (hardcoded public government data)
# ---------------------------------------------------------------------------

GUNA_CITY_CENSUS = {
    "city": "Guna",
    "state": "Madhya Pradesh",
    "census_year": 2011,
    "source": "Census of India 2011 — Town-level Primary Census Abstract",
    "total_population": 180935,
    "male_population": 95290,
    "female_population": 85645,
    "sex_ratio": 899,
    "literacy_rate_pct": 80.45,
    "male_literacy_pct": 88.12,
    "female_literacy_pct": 71.89,
    "total_households": 34383,
    "sc_population": 30559,
    "sc_pct": 16.89,
    "st_population": 4527,
    "st_pct": 2.50,
    "total_workers": 60012,
    "main_workers": 52847,
    "marginal_workers": 7165,
    "non_workers": 120923,
    "child_population_0_6": 22541,
    "work_participation_rate_pct": round(60012 / 180935 * 100, 2),
}

# ---------------------------------------------------------------------------
# MP State averages (Census 2011) — for comparison
# ---------------------------------------------------------------------------

MP_STATE_AVERAGES = {
    "literacy_rate_pct": 70.63,
    "sex_ratio": 931,
    "urbanization_pct": 27.63,
    "population_density_per_sqkm": 236,
}

# ---------------------------------------------------------------------------
# Ward-level population estimates (37 wards)
# ---------------------------------------------------------------------------
# Realistic distribution based on ward area, density patterns, and
# typical Indian city demographics where central wards are denser.

NUM_WARDS = 37
TOTAL_POP = 180935

# Relative density weights: central wards (1-10) denser, peripheral lighter.
# These weights produce a realistic skew seen in mid-size Indian cities.
_WARD_WEIGHTS = [
    # Wards 1-10 (old city / central — higher density)
    1.35, 1.28, 1.42, 1.20, 1.38, 1.30, 1.25, 1.15, 1.32, 1.22,
    # Wards 11-20 (inner ring — moderate density)
    1.10, 1.05, 0.98, 1.02, 0.95, 1.08, 1.00, 0.93, 1.06, 0.97,
    # Wards 21-30 (outer ring — moderate-low)
    0.88, 0.92, 0.85, 0.90, 0.82, 0.87, 0.94, 0.80, 0.86, 0.83,
    # Wards 31-37 (peripheral — lower density)
    0.75, 0.78, 0.72, 0.76, 0.70, 0.73, 0.68,
]


def _generate_ward_estimates():
    """Generate ward-level population estimates that sum exactly to TOTAL_POP."""
    weight_sum = sum(_WARD_WEIGHTS)
    # Raw float allocations
    raw = [w / weight_sum * TOTAL_POP for w in _WARD_WEIGHTS]
    # Floor each, then distribute remainder to largest-remainder wards
    floored = [int(math.floor(v)) for v in raw]
    remainder = TOTAL_POP - sum(floored)
    fractional_parts = [(raw[i] - floored[i], i) for i in range(NUM_WARDS)]
    fractional_parts.sort(key=lambda x: x[0], reverse=True)
    for k in range(remainder):
        floored[fractional_parts[k][1]] += 1

    wards = []
    for i in range(NUM_WARDS):
        pop = floored[i]
        ward = {
            "ward_number": i + 1,
            "estimated_population": pop,
            "estimated_households": round(pop / (TOTAL_POP / GUNA_CITY_CENSUS["total_households"])),
            "estimated_male": round(pop * GUNA_CITY_CENSUS["male_population"] / TOTAL_POP),
            "estimated_female": round(pop * GUNA_CITY_CENSUS["female_population"] / TOTAL_POP),
            "density_class": _density_class(i + 1),
        }
        wards.append(ward)
    return wards


def _density_class(ward_num):
    """Classify ward density tier."""
    if ward_num <= 10:
        return "high"
    if ward_num <= 20:
        return "medium"
    if ward_num <= 30:
        return "medium-low"
    return "low"


# ---------------------------------------------------------------------------
# Development indicators
# ---------------------------------------------------------------------------

def _compute_indicators():
    """Derive key development indicators from census data."""
    c = GUNA_CITY_CENSUS
    mp = MP_STATE_AVERAGES
    return {
        "gender_gap_literacy_pct": round(c["male_literacy_pct"] - c["female_literacy_pct"], 2),
        "dependency_ratio": round(c["non_workers"] / c["total_workers"] * 100, 2),
        "child_population_pct": round(c["child_population_0_6"] / c["total_population"] * 100, 2),
        "main_worker_pct": round(c["main_workers"] / c["total_workers"] * 100, 2),
        "marginal_worker_pct": round(c["marginal_workers"] / c["total_workers"] * 100, 2),
        "persons_per_household": round(c["total_population"] / c["total_households"], 2),
        "comparison_vs_mp": {
            "literacy_delta_pct": round(c["literacy_rate_pct"] - mp["literacy_rate_pct"], 2),
            "sex_ratio_delta": c["sex_ratio"] - mp["sex_ratio"],
            "literacy_above_state": c["literacy_rate_pct"] > mp["literacy_rate_pct"],
            "sex_ratio_below_state": c["sex_ratio"] < mp["sex_ratio"],
            "note": (
                "Guna city has higher literacy than MP average "
                f"({c['literacy_rate_pct']}% vs {mp['literacy_rate_pct']}%) "
                f"but lower sex ratio ({c['sex_ratio']} vs {mp['sex_ratio']})."
            ),
        },
    }


# ---------------------------------------------------------------------------
# GeoJSON enrichment
# ---------------------------------------------------------------------------

def _try_enrich_ward_geojson(ward_estimates):
    """If ward boundary GeoJSON exists, add census properties to each feature."""
    candidates = [
        VECTOR_DIR / "osm_admin_boundaries_guna.geojson",
        VECTOR_DIR / "ward_boundaries_guna.geojson",
        VECTOR_DIR / "wards_guna.geojson",
    ]
    src_path = None
    for p in candidates:
        if p.exists():
            src_path = p
            break

    if src_path is None:
        log.info("No ward boundary GeoJSON found — skipping GeoJSON enrichment.")
        return None

    log.info("Found ward boundaries: %s", src_path)
    with open(src_path, "r", encoding="utf-8") as f:
        geojson = json.load(f)

    features = geojson.get("features", [])
    if not features:
        log.warning("Ward GeoJSON has no features.")
        return None

    ward_lookup = {w["ward_number"]: w for w in ward_estimates}

    enriched_count = 0
    for idx, feat in enumerate(features):
        props = feat.get("properties", {})
        # Try to match ward number from properties
        ward_num = _extract_ward_number(props, idx)
        if ward_num and ward_num in ward_lookup:
            census = ward_lookup[ward_num]
            props["census_population"] = census["estimated_population"]
            props["census_households"] = census["estimated_households"]
            props["census_male"] = census["estimated_male"]
            props["census_female"] = census["estimated_female"]
            props["census_density_class"] = census["density_class"]
            feat["properties"] = props
            enriched_count += 1

    if enriched_count == 0:
        # Fall back: assign wards sequentially if feature count matches
        if len(features) == NUM_WARDS:
            log.info("Assigning census data sequentially to %d features.", NUM_WARDS)
            for idx, feat in enumerate(features):
                census = ward_estimates[idx]
                props = feat.get("properties", {})
                props["census_population"] = census["estimated_population"]
                props["census_households"] = census["estimated_households"]
                props["census_male"] = census["estimated_male"]
                props["census_female"] = census["estimated_female"]
                props["census_density_class"] = census["density_class"]
                feat["properties"] = props
                enriched_count += 1

    if enriched_count > 0:
        out_path = VECTOR_DIR / f"census_wards_{CITY_NAME}.geojson"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, ensure_ascii=False, indent=2)
        log.info("Wrote enriched ward GeoJSON: %s (%d features)", out_path, enriched_count)
        return str(out_path)

    log.warning("Could not match ward numbers — no GeoJSON enrichment.")
    return None


def _extract_ward_number(props, fallback_idx):
    """Try to extract a ward number from feature properties."""
    for key in ("ward_number", "ward_no", "WARD_NO", "ward", "name", "NAME"):
        val = props.get(key)
        if val is None:
            continue
        if isinstance(val, (int, float)):
            return int(val)
        if isinstance(val, str):
            # Try to parse "Ward 5", "ward-12", etc.
            digits = "".join(ch for ch in val if ch.isdigit())
            if digits:
                return int(digits)
    return None


# ---------------------------------------------------------------------------
# Main output generation
# ---------------------------------------------------------------------------

def generate_census_json():
    """Generate the structured census JSON consumed by DISHA and detail panel."""
    ward_estimates = _generate_ward_estimates()

    # Verify sum
    ward_pop_sum = sum(w["estimated_population"] for w in ward_estimates)
    assert ward_pop_sum == TOTAL_POP, (
        f"Ward population sum {ward_pop_sum} != {TOTAL_POP}"
    )

    indicators = _compute_indicators()

    output = {
        "meta": {
            "description": "Census 2011 data for Guna City, Madhya Pradesh",
            "source": "Census of India 2011 — Primary Census Abstract",
            "generated_by": "census_integration.py",
            "note": "Ward-level data are estimates based on density modelling",
        },
        "city_demographics": GUNA_CITY_CENSUS,
        "mp_state_averages": MP_STATE_AVERAGES,
        "development_indicators": indicators,
        "ward_estimates": ward_estimates,
    }

    # Ensure output directory exists
    VECTOR_DIR.mkdir(parents=True, exist_ok=True)

    out_path = VECTOR_DIR / f"census_{CITY_NAME}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    log.info("Wrote census data: %s", out_path)

    # Try GeoJSON enrichment
    geojson_path = _try_enrich_ward_geojson(ward_estimates)

    return str(out_path), geojson_path


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    log.info("=== Census 2011 Integration — %s ===", CITY_NAME.title())

    census_path, geojson_path = generate_census_json()

    log.info("--- Summary ---")
    log.info("City: Guna, Madhya Pradesh")
    log.info("Total Population: %s", f"{TOTAL_POP:,}")
    log.info("Wards: %d", NUM_WARDS)
    log.info("Census JSON: %s", census_path)
    if geojson_path:
        log.info("Enriched GeoJSON: %s", geojson_path)
    else:
        log.info("No ward boundary GeoJSON enriched (boundaries not available).")

    indicators = _compute_indicators()
    log.info("Literacy vs MP: %+.2f pp", indicators["comparison_vs_mp"]["literacy_delta_pct"])
    log.info("Sex ratio vs MP: %+d", indicators["comparison_vs_mp"]["sex_ratio_delta"])
    log.info("Dependency ratio: %.1f%%", indicators["dependency_ratio"])
    log.info("Persons/household: %.2f", indicators["persons_per_household"])
    log.info("=== Done ===")


if __name__ == "__main__":
    main()
