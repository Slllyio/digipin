#!/usr/bin/env python3
"""
Guna Flood Risk Analysis & Simulation
======================================
Analyzes the July 2025 Guna flood event using available geospatial data:
  - DEM (SRTM 90m) → slope, flow direction, flow accumulation
  - LULC (ESA WorldCover 10m) → imperviousness, Manning's n
  - JRC Surface Water (30m) → historical water occurrence
  - OSM vectors → drainage network, buildings, roads
  - SoilGrids → infiltration proxy
  - Open-Meteo climate → rainfall patterns

Outputs:
  - flood_risk_scores.json — per-cell flood vulnerability
  - flood_simulation_results.json — SCS-CN runoff for 328mm event
  - flood_risk_map.html — interactive Leaflet map with all layers
  - flood_analysis_summary.json — key findings and recommendations

Usage:
    python flood_risk_analysis.py
"""

import json
import logging
import math
import sys
from pathlib import Path

import numpy as np

# ── Setup ────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
from config import BBOX, BBOX_CITY, CENTER_LAT, CENTER_LON, CITY_NAME, fix_proj

fix_proj()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("flood")

DATA_DIR = Path(__file__).parent.parent / "data"
RASTER_DIR = DATA_DIR / "rasters"
VECTOR_DIR = DATA_DIR / "vectors"
OUT_DIR = Path(__file__).parent / "output"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Guna 2025 Flood Event Parameters ────────────────────────
FLOOD_EVENT = {
    "date": "2025-07-29",
    "rainfall_mm": 328,        # 12.92 inches in 24 hours
    "duration_hours": 24,
    "peak_intensity_mmh": 40,  # estimated peak hourly rate
    "kalora_dam_breach_m": 4.6,  # 15 feet breach
    "chambal_above_danger_m": 4.0,
    "affected_villages": [
        "Singapore", "Tumda", "Kurka", "Bandha",
        "Umardha", "Baniyani", "Mamli", "Biloda"
    ],
    "urban_affected": ["Cantt Area", "New City Colony", "District Hospital"],
    "people_affected": 3550,
}


# ═══════════════════════════════════════════════════════════
# PART 1: TERRAIN ANALYSIS (DEM-based)
# ═══════════════════════════════════════════════════════════

def analyze_terrain():
    """Compute slope, flow direction, and flow accumulation from SRTM DEM."""
    import rasterio

    dem_path = RASTER_DIR / f"srtm_90m_{CITY_NAME}.tif"
    if not dem_path.exists():
        log.warning("DEM not found: %s", dem_path)
        return None

    log.info("Loading DEM: %s", dem_path.name)
    with rasterio.open(dem_path) as src:
        dem = src.read(1).astype(np.float64)
        transform = src.transform
        nodata = src.nodata
        crs = src.crs
        bounds = src.bounds

    # Replace nodata with NaN
    if nodata is not None:
        dem[dem == nodata] = np.nan

    rows, cols = dem.shape
    cell_size_m = 90  # SRTM 90m

    log.info("  DEM shape: %d x %d, elevation range: %.0f - %.0f m",
             rows, cols, np.nanmin(dem), np.nanmax(dem))

    # ── Slope (degrees) ──
    # Using numpy gradient (finite differences)
    dy, dx = np.gradient(dem, cell_size_m)
    slope_rad = np.arctan(np.sqrt(dx**2 + dy**2))
    slope_deg = np.degrees(slope_rad)
    slope_deg = np.nan_to_num(slope_deg, nan=0.0)

    # ── Flow Direction (D8 algorithm) ──
    # 8 neighbors: NW=1, N=2, NE=3, W=4, E=5, SW=6, S=7, SE=8
    flow_dir = np.zeros_like(dem, dtype=np.int8)
    flow_accum = np.zeros_like(dem, dtype=np.float64)

    # D8 offsets: (row_offset, col_offset)
    d8_offsets = [
        (-1, -1), (-1, 0), (-1, 1),
        (0, -1),           (0, 1),
        (1, -1),  (1, 0),  (1, 1),
    ]
    d8_dist = [
        math.sqrt(2), 1, math.sqrt(2),
        1,               1,
        math.sqrt(2), 1, math.sqrt(2),
    ]

    # Compute flow direction
    for r in range(1, rows - 1):
        for c in range(1, cols - 1):
            if np.isnan(dem[r, c]):
                continue
            max_drop = -1
            max_dir = 0
            for i, (dr, dc) in enumerate(d8_offsets):
                nr, nc = r + dr, c + dc
                if np.isnan(dem[nr, nc]):
                    continue
                drop = (dem[r, c] - dem[nr, nc]) / (d8_dist[i] * cell_size_m)
                if drop > max_drop:
                    max_drop = drop
                    max_dir = i + 1
            flow_dir[r, c] = max_dir

    # ── Flow Accumulation (simplified) ──
    # Sort cells by elevation (highest first) and accumulate downstream
    valid_mask = ~np.isnan(dem)
    coords = np.argwhere(valid_mask)
    elevations = dem[valid_mask]

    # Sort by descending elevation
    sort_idx = np.argsort(-elevations)
    sorted_coords = coords[sort_idx]

    flow_accum[valid_mask] = 1  # Each cell contributes 1

    for idx in range(len(sorted_coords)):
        r, c = sorted_coords[idx]
        d = flow_dir[r, c]
        if d == 0:
            continue
        dr, dc = d8_offsets[d - 1]
        nr, nc = r + dr, c + dc
        if 0 <= nr < rows and 0 <= nc < cols:
            flow_accum[nr, nc] += flow_accum[r, c]

    # ── Depression Detection ──
    # A depression is a cell lower than ALL 8 neighbors (local minimum)
    depressions = np.zeros_like(dem, dtype=bool)
    for r in range(1, rows - 1):
        for c in range(1, cols - 1):
            if np.isnan(dem[r, c]):
                continue
            center = dem[r, c]
            is_depression = True
            for dr, dc in d8_offsets:
                nr, nc = r + dr, c + dc
                if np.isnan(dem[nr, nc]):
                    is_depression = False
                    break
                if dem[nr, nc] <= center:
                    is_depression = False
                    break
            if is_depression:
                depressions[r, c] = True

    # Also flag cells with very low slope AND high flow accumulation (flat flood plains)
    flat_flood = (slope_deg < 1.0) & (flow_accum > np.percentile(flow_accum[valid_mask], 90))
    depressions = depressions | flat_flood

    depression_count = np.sum(depressions)
    log.info("  Slope range: %.1f - %.1f degrees", np.min(slope_deg), np.max(slope_deg))
    log.info("  Flow accumulation max: %.0f cells", np.max(flow_accum))
    log.info("  Depressions (ponding risk): %d cells", depression_count)

    # ── Convert key cells to lat/lon for mapping ──
    def pixel_to_lonlat(row, col):
        x = transform[2] + col * transform[0] + row * transform[1]
        y = transform[5] + col * transform[3] + row * transform[4]
        return float(x), float(y)

    # Top flow accumulation points (potential flood channels)
    flow_threshold = np.percentile(flow_accum[valid_mask], 98)
    high_flow_cells = np.argwhere(flow_accum >= flow_threshold)
    flow_channels = []
    for r, c in high_flow_cells[:200]:
        lon, lat = pixel_to_lonlat(r, c)
        flow_channels.append({
            "lat": lat, "lon": lon,
            "accumulation": float(flow_accum[r, c]),
            "elevation_m": float(dem[r, c]) if not np.isnan(dem[r, c]) else None,
            "slope_deg": float(slope_deg[r, c]),
        })

    # Depression locations
    depression_cells = np.argwhere(depressions)
    depression_points = []
    for r, c in depression_cells[:100]:
        lon, lat = pixel_to_lonlat(r, c)
        depression_points.append({
            "lat": lat, "lon": lon,
            "elevation_m": float(dem[r, c]) if not np.isnan(dem[r, c]) else None,
        })

    # Low-lying areas (bottom 10% elevation within city bbox)
    city_mask = np.zeros_like(dem, dtype=bool)
    for r in range(rows):
        for c in range(cols):
            lon, lat = pixel_to_lonlat(r, c)
            if (BBOX_CITY["west"] <= lon <= BBOX_CITY["east"] and
                    BBOX_CITY["south"] <= lat <= BBOX_CITY["north"]):
                city_mask[r, c] = True

    city_elevations = dem[city_mask & valid_mask]
    if len(city_elevations) > 0:
        low_threshold = np.percentile(city_elevations, 10)
        low_lying = np.argwhere(city_mask & valid_mask & (dem <= low_threshold))
        low_lying_points = []
        for r, c in low_lying[:100]:
            lon, lat = pixel_to_lonlat(r, c)
            low_lying_points.append({
                "lat": lat, "lon": lon,
                "elevation_m": float(dem[r, c]),
            })
    else:
        low_lying_points = []
        low_threshold = 0

    terrain_stats = {
        "dem_shape": [rows, cols],
        "elevation_min_m": float(np.nanmin(dem)),
        "elevation_max_m": float(np.nanmax(dem)),
        "elevation_mean_m": float(np.nanmean(dem)),
        "slope_mean_deg": float(np.mean(slope_deg)),
        "slope_max_deg": float(np.max(slope_deg)),
        "depression_count": int(depression_count),
        "max_flow_accumulation": float(np.max(flow_accum)),
        "low_elevation_threshold_m": float(low_threshold),
        "city_elevation_range_m": [
            float(np.min(city_elevations)) if len(city_elevations) > 0 else 0,
            float(np.max(city_elevations)) if len(city_elevations) > 0 else 0,
        ],
    }

    return {
        "stats": terrain_stats,
        "flow_channels": sorted(flow_channels, key=lambda x: -x["accumulation"]),
        "depressions": depression_points,
        "low_lying_areas": low_lying_points,
    }


# ═══════════════════════════════════════════════════════════
# PART 2: LAND USE & IMPERVIOUSNESS
# ═══════════════════════════════════════════════════════════

# ESA WorldCover 2021 classes → imperviousness & curve number
LULC_PROPERTIES = {
    10: {"name": "Tree cover", "imperv": 0.05, "cn": 55, "mannings_n": 0.15, "color": "#006400"},
    20: {"name": "Shrubland", "imperv": 0.08, "cn": 65, "mannings_n": 0.10, "color": "#ffbb22"},
    30: {"name": "Grassland", "imperv": 0.05, "cn": 61, "mannings_n": 0.08, "color": "#ffff4c"},
    40: {"name": "Cropland", "imperv": 0.10, "cn": 72, "mannings_n": 0.06, "color": "#f096ff"},
    50: {"name": "Built-up", "imperv": 0.85, "cn": 92, "mannings_n": 0.015, "color": "#fa0000"},
    60: {"name": "Bare/sparse", "imperv": 0.15, "cn": 82, "mannings_n": 0.03, "color": "#b4b4b4"},
    70: {"name": "Snow/ice", "imperv": 0.10, "cn": 50, "mannings_n": 0.02, "color": "#f0f0f0"},
    80: {"name": "Water", "imperv": 1.0, "cn": 100, "mannings_n": 0.03, "color": "#0064c8"},
    90: {"name": "Wetland", "imperv": 0.30, "cn": 85, "mannings_n": 0.07, "color": "#0096a0"},
    95: {"name": "Mangroves", "imperv": 0.10, "cn": 70, "mannings_n": 0.12, "color": "#00cf75"},
    100: {"name": "Moss/lichen", "imperv": 0.05, "cn": 60, "mannings_n": 0.05, "color": "#fae6a0"},
}


def analyze_lulc():
    """Analyze land use for imperviousness and runoff curve numbers."""
    import rasterio

    lulc_path = RASTER_DIR / f"worldcover_10m_{CITY_NAME}.tif"
    if not lulc_path.exists():
        log.warning("LULC not found: %s", lulc_path)
        return None

    log.info("Loading LULC: %s", lulc_path.name)
    with rasterio.open(lulc_path) as src:
        lulc = src.read(1)
        transform = src.transform
        bounds = src.bounds

    rows, cols = lulc.shape
    log.info("  LULC shape: %d x %d", rows, cols)

    # Class distribution
    unique, counts = np.unique(lulc, return_counts=True)
    total_pixels = np.sum(counts)

    class_stats = []
    weighted_cn = 0
    weighted_imperv = 0

    for cls, count in zip(unique, counts):
        props = LULC_PROPERTIES.get(int(cls), {})
        if not props:
            continue
        pct = float(count / total_pixels * 100)
        cn = props["cn"]
        imperv = props["imperv"]
        weighted_cn += cn * (count / total_pixels)
        weighted_imperv += imperv * (count / total_pixels)
        class_stats.append({
            "class": int(cls),
            "name": props["name"],
            "pixels": int(count),
            "pct": round(pct, 2),
            "cn": cn,
            "imperviousness": imperv,
        })

    class_stats.sort(key=lambda x: -x["pct"])

    # Built-up area analysis (imperviousness hotspots)
    built_mask = (lulc == 50)
    built_pct = np.sum(built_mask) / total_pixels * 100

    log.info("  Built-up area: %.1f%%", built_pct)
    log.info("  Weighted CN: %.1f", weighted_cn)
    log.info("  Weighted imperviousness: %.1f%%", weighted_imperv * 100)

    return {
        "stats": {
            "total_pixels": int(total_pixels),
            "resolution_m": 10,
            "weighted_curve_number": round(float(weighted_cn), 1),
            "weighted_imperviousness_pct": round(float(weighted_imperv * 100), 1),
            "built_up_pct": round(float(built_pct), 2),
        },
        "class_distribution": class_stats,
    }


# ═══════════════════════════════════════════════════════════
# PART 3: DRAINAGE NETWORK ANALYSIS
# ═══════════════════════════════════════════════════════════

def analyze_drainage():
    """Analyze OSM water features for drainage capacity."""
    water_path = VECTOR_DIR / f"osm_water_{CITY_NAME}.geojson"
    if not water_path.exists():
        log.warning("Water vectors not found: %s", water_path)
        return None

    log.info("Loading water features: %s", water_path.name)
    with open(water_path, encoding="utf-8") as f:
        water_data = json.load(f)

    features = water_data.get("features", [])
    log.info("  Total water features: %d", len(features))

    # Classify water features
    rivers = []
    streams = []
    drains = []
    canals = []
    reservoirs = []
    other_water = []

    for feat in features:
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        waterway = props.get("waterway", "")
        natural = props.get("natural", "")
        water = props.get("water", "")
        name = props.get("name", "Unnamed")

        coords = geom.get("coordinates", [])
        geom_type = geom.get("type", "")

        # Calculate length for line features
        length_km = 0
        if geom_type == "LineString" and len(coords) >= 2:
            for i in range(len(coords) - 1):
                length_km += _haversine(coords[i][1], coords[i][0],
                                        coords[i + 1][1], coords[i + 1][0])

        entry = {
            "name": name,
            "type": waterway or natural or water or "unknown",
            "length_km": round(length_km, 3),
            "geom_type": geom_type,
        }

        # Extract centroid for mapping
        if geom_type == "LineString" and coords:
            mid = coords[len(coords) // 2]
            entry["lat"] = mid[1]
            entry["lon"] = mid[0]
        elif geom_type == "Polygon" and coords and coords[0]:
            lats = [c[1] for c in coords[0]]
            lons = [c[0] for c in coords[0]]
            entry["lat"] = sum(lats) / len(lats)
            entry["lon"] = sum(lons) / len(lons)

        # Also extract all vertex coordinates for proximity analysis
        all_coords = []
        if geom_type == "LineString":
            all_coords = [(c[1], c[0]) for c in coords]  # (lat, lon)
        elif geom_type == "Polygon" and coords and coords[0]:
            all_coords = [(c[1], c[0]) for c in coords[0]]
        entry["all_coords"] = all_coords

        if waterway == "river":
            rivers.append(entry)
        elif waterway == "stream":
            streams.append(entry)
        elif waterway in ("drain", "ditch"):
            drains.append(entry)
        elif waterway == "canal":
            canals.append(entry)
        elif natural == "water" or water in ("reservoir", "pond", "river", ""):
            # Polygon water bodies (ponds, reservoirs, unnamed water)
            if geom_type == "Polygon":
                reservoirs.append(entry)
            else:
                other_water.append(entry)
        else:
            other_water.append(entry)

    total_drain_length = sum(d["length_km"] for d in drains)
    total_river_length = sum(r["length_km"] for r in rivers)
    total_stream_length = sum(s["length_km"] for s in streams)
    total_canal_length = sum(c["length_km"] for c in canals)

    # Drainage density (km of drainage per km2 of city area)
    city_area_km2 = (
        (BBOX_CITY["east"] - BBOX_CITY["west"]) * 111 * math.cos(math.radians(CENTER_LAT)) *
        (BBOX_CITY["north"] - BBOX_CITY["south"]) * 111
    )
    total_drainage_km = total_drain_length + total_stream_length + total_canal_length
    drainage_density = total_drainage_km / city_area_km2 if city_area_km2 > 0 else 0

    log.info("  Rivers: %d (%.1f km)", len(rivers), total_river_length)
    log.info("  Streams: %d (%.1f km)", len(streams), total_stream_length)
    log.info("  Drains: %d (%.1f km)", len(drains), total_drain_length)
    log.info("  Canals: %d (%.1f km)", len(canals), total_canal_length)
    log.info("  Reservoirs/dams: %d", len(reservoirs))
    log.info("  City area: %.1f km2, Drainage density: %.2f km/km2",
             city_area_km2, drainage_density)

    return {
        "stats": {
            "rivers": len(rivers),
            "streams": len(streams),
            "drains": len(drains),
            "canals": len(canals),
            "reservoirs": len(reservoirs),
            "total_river_km": round(total_river_length, 2),
            "total_stream_km": round(total_stream_length, 2),
            "total_drain_km": round(total_drain_length, 2),
            "total_canal_km": round(total_canal_length, 2),
            "city_area_km2": round(city_area_km2, 2),
            "drainage_density_km_per_km2": round(drainage_density, 3),
        },
        "rivers": rivers,
        "streams": streams,
        "drains": drains,
        "canals": canals,
        "reservoirs": reservoirs,
    }


# ═══════════════════════════════════════════════════════════
# PART 4: SURFACE WATER HISTORY (JRC)
# ═══════════════════════════════════════════════════════════

def analyze_surface_water():
    """Analyze JRC Global Surface Water occurrence."""
    import rasterio

    jrc_path = RASTER_DIR / f"jrc_surface_water_{CITY_NAME}.tif"
    if not jrc_path.exists():
        log.warning("JRC surface water not found: %s", jrc_path)
        return None

    log.info("Loading JRC surface water: %s", jrc_path.name)
    with rasterio.open(jrc_path) as src:
        water = src.read(1).astype(np.float64)
        transform = src.transform
        nodata = src.nodata

    if nodata is not None:
        water[water == nodata] = 0

    rows, cols = water.shape
    total = rows * cols

    # Water occurrence classes
    permanent = np.sum(water >= 80)          # >80% occurrence = permanent water
    seasonal = np.sum((water >= 20) & (water < 80))   # seasonal flooding
    occasional = np.sum((water > 0) & (water < 20))   # rare flooding
    dry = np.sum(water == 0)

    log.info("  Permanent water (>80%%): %d cells (%.2f%%)", permanent, permanent / total * 100)
    log.info("  Seasonal water (20-80%%): %d cells (%.2f%%)", seasonal, seasonal / total * 100)
    log.info("  Occasional water (<20%%): %d cells (%.2f%%)", occasional, occasional / total * 100)

    # Extract seasonal/occasional flood zones for mapping
    def pixel_to_lonlat(row, col):
        x = transform[2] + col * transform[0] + row * transform[1]
        y = transform[5] + col * transform[3] + row * transform[4]
        return float(x), float(y)

    flood_zones = []
    seasonal_cells = np.argwhere((water >= 20) & (water < 80))
    for r, c in seasonal_cells[:150]:
        lon, lat = pixel_to_lonlat(r, c)
        flood_zones.append({
            "lat": lat, "lon": lon,
            "occurrence_pct": float(water[r, c]),
            "type": "seasonal",
        })

    permanent_cells = np.argwhere(water >= 80)
    for r, c in permanent_cells[:100]:
        lon, lat = pixel_to_lonlat(r, c)
        flood_zones.append({
            "lat": lat, "lon": lon,
            "occurrence_pct": float(water[r, c]),
            "type": "permanent",
        })

    return {
        "stats": {
            "total_cells": int(total),
            "permanent_water_cells": int(permanent),
            "seasonal_flood_cells": int(seasonal),
            "occasional_flood_cells": int(occasional),
            "dry_cells": int(dry),
            "permanent_pct": round(float(permanent / total * 100), 3),
            "seasonal_pct": round(float(seasonal / total * 100), 3),
        },
        "flood_zones": flood_zones,
    }


# ═══════════════════════════════════════════════════════════
# PART 5: BUILDING EXPOSURE ANALYSIS
# ═══════════════════════════════════════════════════════════

def analyze_building_exposure(terrain_data, drainage_data):
    """Assess building exposure to flood risk based on elevation and drainage proximity."""
    buildings_path = VECTOR_DIR / f"google_open_buildings_{CITY_NAME}.geojson"
    if not buildings_path.exists():
        buildings_path = VECTOR_DIR / f"osm_buildings_{CITY_NAME}.geojson"
    if not buildings_path.exists():
        log.warning("No building data found")
        return None

    log.info("Loading buildings: %s", buildings_path.name)
    with open(buildings_path, encoding="utf-8") as f:
        bldg_data = json.load(f)

    features = bldg_data.get("features", [])
    total_buildings = len(features)
    log.info("  Total buildings: %d", total_buildings)

    # Collect all drain/stream coordinates for proximity analysis
    drain_coords = []
    if drainage_data:
        for category in ["rivers", "streams", "drains", "canals"]:
            for feat in drainage_data.get(category, []):
                # Use all vertex coordinates for accurate proximity
                for coord in feat.get("all_coords", []):
                    drain_coords.append(coord)
                # Fallback to centroid
                if not feat.get("all_coords") and "lat" in feat and "lon" in feat:
                    drain_coords.append((feat["lat"], feat["lon"]))

    # Sample buildings (full set is too large for cell-by-cell analysis)
    sample_size = min(5000, total_buildings)
    step = max(1, total_buildings // sample_size)
    sampled = features[::step][:sample_size]

    # Classify building risk
    high_risk = 0
    medium_risk = 0
    low_risk = 0
    risk_buildings = []

    low_elev_threshold = terrain_data["stats"]["low_elevation_threshold_m"] if terrain_data else 470

    for feat in sampled:
        geom = feat.get("geometry", {})
        coords = geom.get("coordinates", [[]])

        # Get centroid
        if geom["type"] == "Polygon" and coords and coords[0]:
            ring = coords[0]
            lat = sum(c[1] for c in ring) / len(ring)
            lon = sum(c[0] for c in ring) / len(ring)
        else:
            continue

        # Check if within city bbox
        if not (BBOX_CITY["west"] <= lon <= BBOX_CITY["east"] and
                BBOX_CITY["south"] <= lat <= BBOX_CITY["north"]):
            continue

        # Distance to nearest drainage
        min_drain_dist = 999
        for dlat, dlon in drain_coords:
            dist = _haversine(lat, lon, dlat, dlon)
            if dist < min_drain_dist:
                min_drain_dist = dist

        # Risk scoring
        risk_score = 0
        if min_drain_dist < 0.1:  # within 100m of drainage
            risk_score += 40
        elif min_drain_dist < 0.3:
            risk_score += 20
        elif min_drain_dist < 0.5:
            risk_score += 10

        # Low-lying bonus (if we have terrain data)
        # Buildings in depressions or low areas get higher risk
        if terrain_data:
            for dep in terrain_data.get("depressions", [])[:50]:
                if _haversine(lat, lon, dep["lat"], dep["lon"]) < 0.5:
                    risk_score += 30
                    break

        if risk_score >= 40:
            high_risk += 1
            if len(risk_buildings) < 200:
                risk_buildings.append({
                    "lat": lat, "lon": lon,
                    "risk_score": risk_score,
                    "drain_dist_km": round(min_drain_dist, 3),
                    "risk_level": "high",
                })
        elif risk_score >= 20:
            medium_risk += 1
        else:
            low_risk += 1

    # Scale to full building set
    scale = total_buildings / len(sampled) if sampled else 1
    estimated_high = int(high_risk * scale)
    estimated_medium = int(medium_risk * scale)

    log.info("  Sampled %d buildings", len(sampled))
    log.info("  High risk: %d (est. %d total)", high_risk, estimated_high)
    log.info("  Medium risk: %d (est. %d total)", medium_risk, estimated_medium)

    return {
        "stats": {
            "total_buildings": total_buildings,
            "sampled": len(sampled),
            "high_risk_sampled": high_risk,
            "medium_risk_sampled": medium_risk,
            "low_risk_sampled": low_risk,
            "estimated_high_risk": estimated_high,
            "estimated_medium_risk": estimated_medium,
        },
        "high_risk_buildings": risk_buildings,
    }


# ═══════════════════════════════════════════════════════════
# PART 6: SCS-CN RAINFALL-RUNOFF SIMULATION
# ═══════════════════════════════════════════════════════════

def simulate_rainfall_runoff(lulc_data):
    """
    Simulate the July 29, 2025 flood using SCS Curve Number method.

    SCS-CN Formula:
      S = (25400 / CN) - 254        (maximum retention in mm)
      Ia = 0.2 * S                   (initial abstraction)
      Q = (P - Ia)^2 / (P - Ia + S) if P > Ia, else 0

    Where P = rainfall (mm), Q = runoff (mm)
    """
    P = FLOOD_EVENT["rainfall_mm"]  # 328 mm

    if not lulc_data:
        log.warning("No LULC data for runoff simulation, using default CN=75")
        cn_weighted = 75
    else:
        cn_weighted = lulc_data["stats"]["weighted_curve_number"]

    log.info("SCS-CN Runoff Simulation")
    log.info("  Rainfall: %d mm in %d hours", P, FLOOD_EVENT["duration_hours"])
    log.info("  Weighted Curve Number: %.1f", cn_weighted)

    # Run for multiple scenarios
    scenarios = [
        {"name": "Actual Event (Jul 29)", "P_mm": 328, "cn": cn_weighted},
        {"name": "Normal Monsoon Day", "P_mm": 25, "cn": cn_weighted},
        {"name": "Heavy Rain (100mm)", "P_mm": 100, "cn": cn_weighted},
        {"name": "Extreme (200mm)", "P_mm": 200, "cn": cn_weighted},
        {"name": "If 20% More Green Cover", "P_mm": 328, "cn": max(cn_weighted - 8, 40)},
        {"name": "If Improved Drainage", "P_mm": 328, "cn": max(cn_weighted - 5, 40)},
        {"name": "Worst Case (all built-up)", "P_mm": 328, "cn": 92},
    ]

    results = []
    for scenario in scenarios:
        cn = scenario["cn"]
        p = scenario["P_mm"]

        S = (25400 / cn) - 254  # max retention
        Ia = 0.2 * S            # initial abstraction

        if p > Ia:
            Q = (p - Ia) ** 2 / (p - Ia + S)
        else:
            Q = 0

        infiltration = p - Q
        runoff_ratio = Q / p if p > 0 else 0

        # Volume estimate for city area
        city_area_m2 = (
            (BBOX_CITY["east"] - BBOX_CITY["west"]) * 111000 * math.cos(math.radians(CENTER_LAT)) *
            (BBOX_CITY["north"] - BBOX_CITY["south"]) * 111000
        )
        runoff_volume_m3 = Q / 1000 * city_area_m2
        runoff_volume_million_m3 = runoff_volume_m3 / 1e6

        result = {
            "scenario": scenario["name"],
            "rainfall_mm": p,
            "curve_number": round(cn, 1),
            "max_retention_mm": round(S, 1),
            "initial_abstraction_mm": round(Ia, 1),
            "runoff_mm": round(Q, 1),
            "infiltration_mm": round(infiltration, 1),
            "runoff_ratio_pct": round(runoff_ratio * 100, 1),
            "runoff_volume_million_m3": round(runoff_volume_million_m3, 3),
            "city_area_km2": round(city_area_m2 / 1e6, 2),
        }
        results.append(result)

        log.info("  %s: P=%dmm -> Q=%.1fmm (%.0f%% runoff), Vol=%.2fM m3",
                 scenario["name"], p, Q, runoff_ratio * 100, runoff_volume_million_m3)

    # Compare with Kalora dam capacity
    kalora_capacity_m3 = 4.74e6
    actual_runoff = results[0]["runoff_volume_million_m3"] * 1e6
    dam_ratio = actual_runoff / kalora_capacity_m3

    log.info("\n  Kalora Dam capacity: 4.74M m3")
    log.info("  City runoff volume: %.2fM m3 (%.1fx dam capacity)",
             actual_runoff / 1e6, dam_ratio)

    return {
        "scenarios": results,
        "kalora_dam_comparison": {
            "dam_capacity_million_m3": 4.74,
            "city_runoff_million_m3": results[0]["runoff_volume_million_m3"],
            "ratio": round(dam_ratio, 2),
            "verdict": "City runoff exceeded dam capacity" if dam_ratio > 1
            else "Dam could theoretically absorb city runoff",
        },
    }


# ═══════════════════════════════════════════════════════════
# PART 7: FLOOD RISK SCORING (COMPOSITE)
# ═══════════════════════════════════════════════════════════

def compute_flood_risk_scores(terrain, lulc, drainage, water, buildings):
    """Compute composite flood risk zones by combining all layers."""
    log.info("Computing composite flood risk scores...")

    risk_zones = []

    # Build a flat list of ALL water coords for fast proximity lookup
    all_water_coords = []
    if drainage:
        for category in ["rivers", "streams", "drains", "canals", "reservoirs"]:
            for feat in drainage.get(category, []):
                for coord in feat.get("all_coords", []):
                    all_water_coords.append(coord)
    log.info("  Water proximity coords: %d", len(all_water_coords))

    # Grid the wider area into ~500m cells (rivers are outside tight city bbox)
    lat_step = 0.005   # ~500m
    lon_step = 0.005

    # Use a bbox that covers the urban area + buffer for river proximity
    grid_bbox = {
        "south": BBOX_CITY["south"] - 0.05,
        "north": BBOX_CITY["north"] + 0.05,
        "west": BBOX_CITY["west"] - 0.05,
        "east": BBOX_CITY["east"] + 0.05,
    }

    lat_range = np.arange(grid_bbox["south"], grid_bbox["north"], lat_step)
    lon_range = np.arange(grid_bbox["west"], grid_bbox["east"], lon_step)

    for lat in lat_range:
        for lon in lon_range:
            score = 0
            factors = []

            # Factor 1: Proximity to water (closer = higher risk)
            if all_water_coords:
                min_dist = 999
                for wlat, wlon in all_water_coords:
                    # Quick degree-based filter before expensive haversine
                    if abs(wlat - lat) > 0.1 or abs(wlon - lon) > 0.1:
                        continue
                    d = _haversine(lat, lon, wlat, wlon)
                    if d < min_dist:
                        min_dist = d

                if min_dist < 0.5:
                    score += 25
                    factors.append(f"Near river/water body ({min_dist:.1f}km)")
                elif min_dist < 1.5:
                    score += 15
                    factors.append(f"Moderate water proximity ({min_dist:.1f}km)")
                elif min_dist < 3.0:
                    score += 5
                    factors.append(f"Within river influence zone ({min_dist:.1f}km)")

            # Factor 2: Low elevation / depression
            if terrain:
                for dep in terrain.get("depressions", []):
                    if _haversine(lat, lon, dep["lat"], dep["lon"]) < 0.5:
                        score += 20
                        factors.append("Topographic depression / flat flood zone")
                        break

                for low in terrain.get("low_lying_areas", []):
                    if _haversine(lat, lon, low["lat"], low["lon"]) < 0.5:
                        score += 15
                        factors.append(f"Low-lying ({low['elevation_m']:.0f}m)")
                        break

            # Factor 3: Flow accumulation (natural drainage paths)
            if terrain:
                for ch in terrain.get("flow_channels", [])[:80]:
                    if _haversine(lat, lon, ch["lat"], ch["lon"]) < 0.5:
                        score += 15
                        factors.append(f"Flow channel (accum={ch['accumulation']:.0f})")
                        break

            # Factor 4: Historical surface water
            if water:
                for zone in water.get("flood_zones", []):
                    if _haversine(lat, lon, zone["lat"], zone["lon"]) < 0.8:
                        if zone["type"] == "seasonal":
                            score += 20
                            factors.append(f"Seasonal flooding ({zone['occurrence_pct']:.0f}%)")
                        elif zone["type"] == "permanent":
                            score += 10
                            factors.append("Near permanent water")
                        break

            # Factor 5: Built-up density (high imperviousness = more runoff)
            # Approximate from LULC stats
            if lulc and lulc["stats"]["built_up_pct"] > 30:
                score += 10
                factors.append("High urbanization")

            # Classify risk level
            if score >= 50:
                risk_level = "critical"
            elif score >= 35:
                risk_level = "high"
            elif score >= 20:
                risk_level = "moderate"
            else:
                risk_level = "low"

            risk_zones.append({
                "lat": round(float(lat), 5),
                "lon": round(float(lon), 5),
                "risk_score": score,
                "risk_level": risk_level,
                "factors": factors,
            })

    # Count by risk level
    critical = sum(1 for z in risk_zones if z["risk_level"] == "critical")
    high = sum(1 for z in risk_zones if z["risk_level"] == "high")
    moderate = sum(1 for z in risk_zones if z["risk_level"] == "moderate")
    low = sum(1 for z in risk_zones if z["risk_level"] == "low")

    log.info("  Risk zones: %d critical, %d high, %d moderate, %d low",
             critical, high, moderate, low)

    return {
        "stats": {
            "total_zones": len(risk_zones),
            "critical": critical,
            "high": high,
            "moderate": moderate,
            "low": low,
        },
        "zones": risk_zones,
    }


# ═══════════════════════════════════════════════════════════
# PART 8: PREVENTION RECOMMENDATIONS
# ═══════════════════════════════════════════════════════════

def generate_recommendations(terrain, lulc, drainage, simulation, risk_scores):
    """Generate actionable flood prevention recommendations."""
    recs = []

    # 1. Dam infrastructure
    recs.append({
        "priority": "CRITICAL",
        "category": "Dam Safety",
        "title": "Kalora Dam Rehabilitation",
        "details": (
            "The 70-year-old Kalora Dam (built 1956, 4.74M m3 capacity) suffered a 15-foot "
            "west weir breach. Immediate structural assessment and reinforcement required. "
            "Consider spillway capacity upgrade to handle 328mm/24hr events."
        ),
        "cost_estimate": "Rs 15-25 Crore",
        "timeline": "6-12 months",
    })

    # 2. Drainage improvement
    drain_density = 0
    if drainage:
        drain_density = drainage["stats"]["drainage_density_km_per_km2"]
    recs.append({
        "priority": "CRITICAL",
        "category": "Storm Drainage",
        "title": "Upgrade Urban Storm Drainage Network",
        "details": (
            f"Current drainage density: {drain_density:.2f} km/km2 (minimum recommended: 3.0). "
            "Construct new stormwater drains along major roads. Clear encroachments from existing "
            "nalas. Install trash screens at drain inlets to prevent clogging."
        ),
        "cost_estimate": "Rs 50-80 Crore",
        "timeline": "2-3 years",
    })

    # 3. Retention ponds
    runoff_vol = 0
    if simulation:
        runoff_vol = simulation["scenarios"][0]["runoff_volume_million_m3"]
    recs.append({
        "priority": "HIGH",
        "category": "Water Retention",
        "title": "Construct Retention/Detention Ponds",
        "details": (
            f"City generates {runoff_vol:.2f}M m3 runoff in a 328mm event. Build 4-6 retention "
            "ponds (each 0.5-1M m3) at topographic depressions and flow accumulation points "
            "identified in the DEM analysis. These can double as parks in dry season."
        ),
        "cost_estimate": "Rs 20-35 Crore",
        "timeline": "1-2 years",
    })

    # 4. Green infrastructure
    built_pct = 0
    if lulc:
        built_pct = lulc["stats"]["built_up_pct"]
    recs.append({
        "priority": "HIGH",
        "category": "Green Infrastructure",
        "title": "Increase Permeable Surfaces & Green Cover",
        "details": (
            f"Built-up area is {built_pct:.1f}% with high imperviousness. Implement: "
            "permeable pavements in parking lots, rain gardens at government buildings, "
            "green roofs on new construction. Target: reduce effective CN by 5-8 points, "
            "which would reduce runoff by ~15% in extreme events."
        ),
        "cost_estimate": "Rs 10-15 Crore",
        "timeline": "2-4 years",
    })

    # 5. Early warning system
    recs.append({
        "priority": "HIGH",
        "category": "Early Warning",
        "title": "Flood Early Warning System",
        "details": (
            "Install river level gauges on Sindh, Jhagar, and Bhaunra rivers. Deploy "
            "automated rain gauges (AWS) at 5 locations across the city. Connect to IMD "
            "and CWC for real-time alerts. SMS/sirens for downstream villages."
        ),
        "cost_estimate": "Rs 3-5 Crore",
        "timeline": "6-9 months",
    })

    # 6. Encroachment removal
    recs.append({
        "priority": "HIGH",
        "category": "Regulatory",
        "title": "Remove Nala & Floodplain Encroachments",
        "details": (
            "Enforce buffer zones: 30m for rivers, 15m for nalas/drains. Survey and "
            "demarcate flood zones identified in this analysis. Relocate structures "
            "from the Cantt Area and New City Colony flood zones."
        ),
        "cost_estimate": "Rs 5-10 Crore (rehabilitation)",
        "timeline": "1-2 years",
    })

    # 7. Rainwater harvesting
    recs.append({
        "priority": "MEDIUM",
        "category": "Water Harvesting",
        "title": "Mandatory Rainwater Harvesting",
        "details": (
            "Mandate rooftop rainwater harvesting for all buildings >100 sq.m. "
            "Estimate: 70,000+ buildings could capture 5-10% of total rainfall, "
            "reducing peak runoff and recharging groundwater."
        ),
        "cost_estimate": "Rs 8-12 Crore (subsidies)",
        "timeline": "3-5 years",
    })

    # 8. Road drainage
    recs.append({
        "priority": "MEDIUM",
        "category": "Road Infrastructure",
        "title": "Redesign Road Cross-Sections with Drainage",
        "details": (
            "All major roads should have side drains with capacity for 50mm/hr rainfall. "
            "Priority: Guna-Kota road (destroyed bridge at Kudka river), roads connecting "
            "to Fatehgarh and Padon. Add culverts at every nala crossing."
        ),
        "cost_estimate": "Rs 30-40 Crore",
        "timeline": "2-3 years",
    })

    return recs


# ═══════════════════════════════════════════════════════════
# PART 9: INTERACTIVE FLOOD RISK MAP
# ═══════════════════════════════════════════════════════════

def generate_flood_map(terrain, drainage, water, risk_scores,
                       simulation, buildings, recommendations):
    """Generate interactive Leaflet map with all flood analysis layers."""
    log.info("Generating interactive flood risk map...")

    # Prepare data for JS
    risk_zones_json = json.dumps(risk_scores["zones"] if risk_scores else [])
    flow_channels_json = json.dumps(terrain["flow_channels"][:100] if terrain else [])
    depressions_json = json.dumps(terrain["depressions"][:50] if terrain else [])
    low_lying_json = json.dumps(terrain["low_lying_areas"][:50] if terrain else [])
    flood_zones_json = json.dumps(water["flood_zones"][:200] if water else [])

    rivers_json = json.dumps(drainage["rivers"] if drainage else [])
    drains_json = json.dumps(drainage["drains"] + drainage.get("streams", []) if drainage else [])

    high_risk_bldg_json = json.dumps(buildings["high_risk_buildings"][:100] if buildings else [])

    scenarios_json = json.dumps(simulation["scenarios"] if simulation else [])
    dam_json = json.dumps(simulation["kalora_dam_comparison"] if simulation else {})
    recs_json = json.dumps(recommendations or [])

    event_json = json.dumps(FLOOD_EVENT)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Guna Flood Risk Analysis &mdash; July 2025 Event</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0e17; color: #e0e0e0; display: flex; height: 100vh; }}

  #map {{ flex: 1; }}

  #panel {{
    width: 420px; background: #0d1117; overflow-y: auto; padding: 20px;
    border-left: 1px solid #1b2838;
  }}
  h1 {{ font-size: 18px; color: #ff6b35; margin-bottom: 4px; }}
  .subtitle {{ font-size: 12px; color: #888; margin-bottom: 16px; }}

  .tabs {{ display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }}
  .tab {{
    padding: 6px 12px; font-size: 11px; border-radius: 6px; cursor: pointer;
    background: #1b2838; color: #888; border: 1px solid #1b2838;
    transition: all 0.2s;
  }}
  .tab.active {{ background: #ff6b35; color: #fff; border-color: #ff6b35; }}

  .section {{ display: none; }}
  .section.active {{ display: block; }}

  .card {{
    background: #0d2137; border: 1px solid rgba(255,107,53,0.3); border-radius: 10px;
    padding: 14px; margin: 10px 0;
  }}
  .card-title {{ font-size: 13px; font-weight: 700; color: #ff6b35; margin-bottom: 8px; }}

  .stat-row {{ display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }}
  .stat-label {{ color: #888; }}
  .stat-val {{ font-weight: 600; color: #fff; }}
  .stat-val.critical {{ color: #ff4444; }}
  .stat-val.warning {{ color: #ff9800; }}
  .stat-val.good {{ color: #00e676; }}

  .rec-item {{
    background: #0d2137; border-radius: 8px; padding: 12px; margin: 8px 0;
    border-left: 4px solid #ff6b35;
  }}
  .rec-item.CRITICAL {{ border-left-color: #ff4444; }}
  .rec-item.HIGH {{ border-left-color: #ff9800; }}
  .rec-item.MEDIUM {{ border-left-color: #ffeb3b; }}
  .rec-priority {{ font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-bottom: 4px; }}
  .rec-priority.CRITICAL {{ background: #ff4444; color: #fff; }}
  .rec-priority.HIGH {{ background: #ff9800; color: #000; }}
  .rec-priority.MEDIUM {{ background: #ffeb3b; color: #000; }}
  .rec-title {{ font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 4px; }}
  .rec-details {{ font-size: 11px; color: #aaa; line-height: 1.5; }}
  .rec-meta {{ font-size: 10px; color: #666; margin-top: 6px; }}

  .scenario-row {{
    display: flex; justify-content: space-between; padding: 4px 0;
    font-size: 12px; border-bottom: 1px solid #1b2838;
  }}
  .scenario-row:last-child {{ border-bottom: none; }}

  .legend-item {{ display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 11px; }}
  .legend-dot {{
    width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  }}

  .event-banner {{
    background: linear-gradient(135deg, #1a0000 0%, #330000 100%);
    border: 1px solid #ff4444; border-radius: 10px; padding: 14px;
    margin-bottom: 16px;
  }}
  .event-banner h2 {{ font-size: 14px; color: #ff4444; margin-bottom: 6px; }}
  .event-banner p {{ font-size: 11px; color: #ccc; line-height: 1.5; }}
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
  <h1>Guna Flood Risk Analysis</h1>
  <div class="subtitle">July 2025 Monsoon Event &mdash; 328mm/24hr</div>

  <div class="event-banner" id="event-banner"></div>

  <div class="tabs" id="tabs"></div>

  <div class="section active" id="sec-overview"></div>
  <div class="section" id="sec-terrain"></div>
  <div class="section" id="sec-simulation"></div>
  <div class="section" id="sec-recommendations"></div>
</div>

<script>
// ── Data ──
const riskZones = {risk_zones_json};
const flowChannels = {flow_channels_json};
const depressions = {depressions_json};
const lowLying = {low_lying_json};
const floodZones = {flood_zones_json};
const rivers = {rivers_json};
const drains = {drains_json};
const highRiskBldg = {high_risk_bldg_json};
const scenarios = {scenarios_json};
const damComparison = {dam_json};
const recommendations = {recs_json};
const floodEvent = {event_json};

// ── Map ──
const map = L.map('map', {{
  center: [{CENTER_LAT}, {CENTER_LON}],
  zoom: 13,
  zoomControl: true,
}});
L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}@2x.png', {{
  attribution: '&copy; CARTO &copy; OSM',
  maxZoom: 19,
}}).addTo(map);

// ── Risk colors ──
function riskColor(level) {{
  switch(level) {{
    case 'critical': return '#ff4444';
    case 'high': return '#ff9800';
    case 'moderate': return '#ffeb3b';
    default: return '#00e676';
  }}
}}

// ── Layers ──
const riskLayer = L.layerGroup().addTo(map);
const flowLayer = L.layerGroup();
const depressionLayer = L.layerGroup();
const waterHistoryLayer = L.layerGroup();
const drainageLayer = L.layerGroup().addTo(map);
const buildingRiskLayer = L.layerGroup();

// Risk zones (grid cells)
riskZones.forEach(function(z) {{
  if (z.risk_score < 10) return;
  L.circle([z.lat, z.lon], {{
    radius: 250,
    color: riskColor(z.risk_level),
    weight: 1,
    opacity: 0.6,
    fillColor: riskColor(z.risk_level),
    fillOpacity: 0.25,
  }}).addTo(riskLayer).bindPopup(
    '<b>Risk: ' + z.risk_level.toUpperCase() + '</b> (score: ' + z.risk_score + ')<br>' +
    z.factors.map(function(f) {{ return '&bull; ' + f; }}).join('<br>')
  );
}});

// Flow channels
flowChannels.forEach(function(ch) {{
  L.circleMarker([ch.lat, ch.lon], {{
    radius: Math.min(3 + ch.accumulation / 500, 10),
    color: '#2196f3',
    weight: 0,
    fillColor: '#2196f3',
    fillOpacity: 0.6,
  }}).addTo(flowLayer).bindPopup(
    '<b>Flow Channel</b><br>Accumulation: ' + ch.accumulation.toFixed(0) +
    ' cells<br>Elevation: ' + (ch.elevation_m ? ch.elevation_m.toFixed(0) + 'm' : '?')
  );
}});

// Depressions
depressions.forEach(function(d) {{
  L.circleMarker([d.lat, d.lon], {{
    radius: 6,
    color: '#9c27b0',
    weight: 2,
    fillColor: '#9c27b0',
    fillOpacity: 0.5,
  }}).addTo(depressionLayer).bindPopup(
    '<b>Topographic Depression</b><br>Ponding risk zone<br>Elevation: ' +
    (d.elevation_m ? d.elevation_m.toFixed(0) + 'm' : '?')
  );
}});

// Historical water (JRC)
floodZones.forEach(function(z) {{
  const color = z.type === 'permanent' ? '#0064c8' : '#00bcd4';
  L.circleMarker([z.lat, z.lon], {{
    radius: 4,
    color: color,
    weight: 0,
    fillColor: color,
    fillOpacity: 0.5,
  }}).addTo(waterHistoryLayer).bindPopup(
    '<b>' + z.type.charAt(0).toUpperCase() + z.type.slice(1) + ' Water</b><br>' +
    'Occurrence: ' + z.occurrence_pct.toFixed(0) + '%'
  );
}});

// Drainage network
rivers.forEach(function(r) {{
  if (r.lat && r.lon) {{
    L.circleMarker([r.lat, r.lon], {{
      radius: 8, color: '#1565c0', weight: 2, fillColor: '#1565c0', fillOpacity: 0.4,
    }}).addTo(drainageLayer).bindPopup(
      '<b>River: ' + r.name + '</b><br>Length: ' + r.length_km + ' km'
    );
  }}
}});
drains.forEach(function(d) {{
  if (d.lat && d.lon) {{
    L.circleMarker([d.lat, d.lon], {{
      radius: 5, color: '#4fc3f7', weight: 1, fillColor: '#4fc3f7', fillOpacity: 0.4,
    }}).addTo(drainageLayer).bindPopup(
      '<b>' + d.type + ': ' + d.name + '</b><br>Length: ' + d.length_km + ' km'
    );
  }}
}});

// High risk buildings
highRiskBldg.forEach(function(b) {{
  L.circleMarker([b.lat, b.lon], {{
    radius: 4, color: '#ff1744', weight: 1, fillColor: '#ff1744', fillOpacity: 0.6,
  }}).addTo(buildingRiskLayer).bindPopup(
    '<b>High Risk Building</b><br>Score: ' + b.risk_score +
    '<br>Distance to drain: ' + b.drain_dist_km + ' km'
  );
}});

// Affected locations markers
const affectedMarkers = L.layerGroup().addTo(map);
// Kalora Dam (Bamori area, ~24.75N, 77.35E approximate)
L.marker([24.75, 77.35], {{
  icon: L.divIcon({{
    className: '',
    html: '<div style="background:#ff4444;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;white-space:nowrap;border:2px solid #fff">KALORA DAM<br>15ft Breach</div>',
    iconSize: [90, 35], iconAnchor: [45, 17]
  }})
}}).addTo(affectedMarkers).bindPopup(
  '<b>Kalora Dam</b><br>Built: 1956 (70 years old)<br>Capacity: 4.74M m3<br>' +
  'West weir breach: 15 feet (4.6m)<br>Date: July 29, 2025<br>' +
  'Affected: 8 villages, 3,550 people'
);

// Cantt Area & New City Colony (urban affected)
L.marker([24.638, 77.308], {{
  icon: L.divIcon({{
    className: '',
    html: '<div style="background:#ff9800;color:#000;font-size:9px;font-weight:700;padding:2px 6px;border-radius:6px;white-space:nowrap">CANTT AREA<br>Submerged</div>',
    iconSize: [70, 28], iconAnchor: [35, 14]
  }})
}}).addTo(affectedMarkers);

L.marker([24.645, 77.320], {{
  icon: L.divIcon({{
    className: '',
    html: '<div style="background:#ff9800;color:#000;font-size:9px;font-weight:700;padding:2px 6px;border-radius:6px;white-space:nowrap">NEW CITY COLONY<br>Submerged</div>',
    iconSize: [85, 28], iconAnchor: [42, 14]
  }})
}}).addTo(affectedMarkers);

L.marker([24.635, 77.315], {{
  icon: L.divIcon({{
    className: '',
    html: '<div style="background:#ff4444;color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:6px;white-space:nowrap">DISTRICT HOSPITAL<br>Flooded</div>',
    iconSize: [95, 28], iconAnchor: [47, 14]
  }})
}}).addTo(affectedMarkers);

// Layer control
L.control.layers(null, {{
  'Flood Risk Zones': riskLayer,
  'Flow Channels': flowLayer,
  'Depressions': depressionLayer,
  'Historical Water (JRC)': waterHistoryLayer,
  'Drainage Network': drainageLayer,
  'High-Risk Buildings': buildingRiskLayer,
  'Affected Locations': affectedMarkers,
}}, {{ position: 'topright', collapsed: true }}).addTo(map);

// ── Panel: Event Banner ──
(function() {{
  const banner = document.getElementById('event-banner');
  const h = document.createElement('h2');
  h.textContent = 'FLOOD EVENT: July 29, 2025';
  banner.appendChild(h);

  const lines = [
    '328mm (12.92 inches) rainfall in 24 hours',
    'Kalora Dam west weir breached by 15 feet',
    'Chambal River 4m above danger mark',
    'Cantt Area, New City Colony, District Hospital submerged',
    '8 villages flooded, 3,550 people affected',
    'NDRF + Army deployed for rescue operations',
  ];
  lines.forEach(function(line) {{
    const p = document.createElement('p');
    p.textContent = '\\u2022 ' + line;
    banner.appendChild(p);
  }});
}})();

// ── Panel: Tabs ──
(function() {{
  const tabContainer = document.getElementById('tabs');
  const tabNames = ['Overview', 'Terrain', 'Simulation', 'Recommendations'];
  const sectionIds = ['sec-overview', 'sec-terrain', 'sec-simulation', 'sec-recommendations'];

  tabNames.forEach(function(name, i) {{
    const tab = document.createElement('div');
    tab.className = 'tab' + (i === 0 ? ' active' : '');
    tab.textContent = name;
    tab.addEventListener('click', function() {{
      document.querySelectorAll('.tab').forEach(function(t) {{ t.classList.remove('active'); }});
      document.querySelectorAll('.section').forEach(function(s) {{ s.classList.remove('active'); }});
      tab.classList.add('active');
      document.getElementById(sectionIds[i]).classList.add('active');
    }});
    tabContainer.appendChild(tab);
  }});
}})();

// ── Tab: Overview ──
(function() {{
  const sec = document.getElementById('sec-overview');

  // Risk summary
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'FLOOD RISK SUMMARY';
  card.appendChild(title);

  const stats = [
    ['Critical zones', riskZones.filter(function(z){{ return z.risk_level==='critical'; }}).length, 'critical'],
    ['High risk zones', riskZones.filter(function(z){{ return z.risk_level==='high'; }}).length, 'warning'],
    ['Moderate zones', riskZones.filter(function(z){{ return z.risk_level==='moderate'; }}).length, ''],
    ['Low risk zones', riskZones.filter(function(z){{ return z.risk_level==='low'; }}).length, 'good'],
  ];
  stats.forEach(function(s) {{
    const row = document.createElement('div');
    row.className = 'stat-row';
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = s[0];
    const val = document.createElement('span');
    val.className = 'stat-val ' + s[2];
    val.textContent = s[1];
    row.appendChild(label);
    row.appendChild(val);
    card.appendChild(row);
  }});
  sec.appendChild(card);

  // Causes card
  const causes = document.createElement('div');
  causes.className = 'card';
  const ct = document.createElement('div');
  ct.className = 'card-title';
  ct.textContent = 'ROOT CAUSES IDENTIFIED';
  causes.appendChild(ct);

  const causeList = [
    ['Extreme rainfall', '328mm in 24hrs (13x normal daily avg)'],
    ['Dam failure', 'Kalora Dam (70 yrs old) weir breach'],
    ['River overflow', 'Chambal 4m above danger mark'],
    ['Poor drainage', 'Encroachments on nalas reduce capacity'],
    ['High imperviousness', 'Built-up area increases runoff'],
    ['Low-lying urban zones', 'Cantt, New City in depression areas'],
    ['Bridge destruction', 'Kudka river bridge severed roads'],
  ];
  causeList.forEach(function(c) {{
    const row = document.createElement('div');
    row.className = 'stat-row';
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = c[0];
    const val = document.createElement('span');
    val.className = 'stat-val';
    val.textContent = c[1];
    row.appendChild(label);
    row.appendChild(val);
    causes.appendChild(row);
  }});
  sec.appendChild(causes);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'card';
  const lt = document.createElement('div');
  lt.className = 'card-title';
  lt.textContent = 'MAP LEGEND';
  legend.appendChild(lt);

  const legendItems = [
    ['#ff4444', 'Critical flood risk'],
    ['#ff9800', 'High flood risk'],
    ['#ffeb3b', 'Moderate flood risk'],
    ['#00e676', 'Low flood risk'],
    ['#2196f3', 'Flow channels (DEM)'],
    ['#9c27b0', 'Depressions (ponding)'],
    ['#00bcd4', 'Historical flooding (JRC)'],
    ['#4fc3f7', 'Drainage network'],
    ['#ff1744', 'High-risk buildings'],
  ];
  legendItems.forEach(function(item) {{
    const li = document.createElement('div');
    li.className = 'legend-item';
    const dot = document.createElement('div');
    dot.className = 'legend-dot';
    dot.style.backgroundColor = item[0];
    const txt = document.createElement('span');
    txt.textContent = item[1];
    li.appendChild(dot);
    li.appendChild(txt);
    legend.appendChild(li);
  }});
  sec.appendChild(legend);
}})();

// ── Tab: Terrain ──
(function() {{
  const sec = document.getElementById('sec-terrain');

  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'TERRAIN ANALYSIS';
  card.appendChild(title);

  const tStats = [
    ['Flow channels identified', flowChannels.length],
    ['Topographic depressions', depressions.length],
    ['Low-lying areas', lowLying.length],
    ['Historical flood zones (JRC)', floodZones.length],
    ['Drainage features', rivers.length + drains.length],
  ];
  tStats.forEach(function(s) {{
    const row = document.createElement('div');
    row.className = 'stat-row';
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = s[0];
    const val = document.createElement('span');
    val.className = 'stat-val';
    val.textContent = s[1];
    row.appendChild(label);
    row.appendChild(val);
    card.appendChild(row);
  }});
  sec.appendChild(card);

  // Toggle layers instructions
  const note = document.createElement('div');
  note.className = 'card';
  note.style.fontSize = '11px';
  note.style.color = '#888';
  note.textContent = 'Use the Layers control (top-right) to toggle: Flow Channels, Depressions, Historical Water, High-Risk Buildings.';
  sec.appendChild(note);
}})();

// ── Tab: Simulation ──
(function() {{
  const sec = document.getElementById('sec-simulation');

  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'SCS-CN RUNOFF SIMULATION';
  card.appendChild(title);

  // Header row
  const hdr = document.createElement('div');
  hdr.className = 'scenario-row';
  hdr.style.fontWeight = '600';
  hdr.style.color = '#aaa';
  ['Scenario', 'Rain', 'Runoff', 'Vol'].forEach(function(h) {{
    const s = document.createElement('span');
    s.textContent = h;
    s.style.flex = '1';
    hdr.appendChild(s);
  }});
  card.appendChild(hdr);

  scenarios.forEach(function(sc) {{
    const row = document.createElement('div');
    row.className = 'scenario-row';

    const name = document.createElement('span');
    name.textContent = sc.scenario;
    name.style.flex = '1.5';
    name.style.fontSize = '11px';

    const rain = document.createElement('span');
    rain.textContent = sc.rainfall_mm + 'mm';
    rain.style.flex = '0.7';

    const runoff = document.createElement('span');
    runoff.textContent = sc.runoff_mm + 'mm (' + sc.runoff_ratio_pct + '%)';
    runoff.style.flex = '1.2';
    runoff.style.color = sc.runoff_ratio_pct > 80 ? '#ff4444' : sc.runoff_ratio_pct > 50 ? '#ff9800' : '#00e676';

    const vol = document.createElement('span');
    vol.textContent = sc.runoff_volume_million_m3 + 'M m3';
    vol.style.flex = '0.8';

    row.appendChild(name);
    row.appendChild(rain);
    row.appendChild(runoff);
    row.appendChild(vol);
    card.appendChild(row);
  }});
  sec.appendChild(card);

  // Dam comparison
  if (damComparison && damComparison.dam_capacity_million_m3) {{
    const dam = document.createElement('div');
    dam.className = 'card';
    const dt = document.createElement('div');
    dt.className = 'card-title';
    dt.textContent = 'KALORA DAM COMPARISON';
    dam.appendChild(dt);

    const dStats = [
      ['Dam capacity', damComparison.dam_capacity_million_m3 + 'M m3'],
      ['City runoff (328mm event)', damComparison.city_runoff_million_m3 + 'M m3'],
      ['Runoff / Dam ratio', damComparison.ratio + 'x'],
    ];
    dStats.forEach(function(s) {{
      const row = document.createElement('div');
      row.className = 'stat-row';
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = s[0];
      const val = document.createElement('span');
      val.className = 'stat-val ' + (damComparison.ratio > 1 ? 'critical' : 'good');
      val.textContent = s[1];
      row.appendChild(label);
      row.appendChild(val);
      dam.appendChild(row);
    }});

    const verdict = document.createElement('div');
    verdict.style.cssText = 'margin-top:8px;padding:8px;background:#330000;border:1px solid #ff4444;border-radius:6px;font-size:11px;color:#ff4444;text-align:center';
    verdict.textContent = damComparison.verdict;
    dam.appendChild(verdict);
    sec.appendChild(dam);
  }}
}})();

// ── Tab: Recommendations ──
(function() {{
  const sec = document.getElementById('sec-recommendations');

  const heading = document.createElement('div');
  heading.className = 'card-title';
  heading.textContent = 'FLOOD PREVENTION RECOMMENDATIONS';
  heading.style.marginBottom = '12px';
  sec.appendChild(heading);

  recommendations.forEach(function(rec) {{
    const item = document.createElement('div');
    item.className = 'rec-item ' + rec.priority;

    const badge = document.createElement('span');
    badge.className = 'rec-priority ' + rec.priority;
    badge.textContent = rec.priority + ' - ' + rec.category;
    item.appendChild(badge);

    const title = document.createElement('div');
    title.className = 'rec-title';
    title.textContent = rec.title;
    item.appendChild(title);

    const details = document.createElement('div');
    details.className = 'rec-details';
    details.textContent = rec.details;
    item.appendChild(details);

    const meta = document.createElement('div');
    meta.className = 'rec-meta';
    meta.textContent = 'Cost: ' + rec.cost_estimate + ' | Timeline: ' + rec.timeline;
    item.appendChild(meta);

    sec.appendChild(item);
  }});
}})();
</script>
</body>
</html>"""

    out_path = OUT_DIR / "flood_risk_map.html"
    out_path.write_text(html, encoding="utf-8")
    log.info("  Saved: %s", out_path)
    return out_path


# ═══════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════

def _haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("GUNA FLOOD RISK ANALYSIS & SIMULATION")
    print("Event: July 29, 2025 — 328mm rainfall in 24 hours")
    print("=" * 60)

    # Part 1: Terrain
    print("\n" + "=" * 60)
    print("PART 1: TERRAIN ANALYSIS")
    print("=" * 60)
    terrain = analyze_terrain()

    # Part 2: Land use
    print("\n" + "=" * 60)
    print("PART 2: LAND USE & IMPERVIOUSNESS")
    print("=" * 60)
    lulc = analyze_lulc()

    # Part 3: Drainage
    print("\n" + "=" * 60)
    print("PART 3: DRAINAGE NETWORK")
    print("=" * 60)
    drainage = analyze_drainage()

    # Part 4: Surface water history
    print("\n" + "=" * 60)
    print("PART 4: HISTORICAL SURFACE WATER")
    print("=" * 60)
    water = analyze_surface_water()

    # Part 5: Building exposure
    print("\n" + "=" * 60)
    print("PART 5: BUILDING EXPOSURE")
    print("=" * 60)
    buildings = analyze_building_exposure(terrain, drainage)

    # Part 6: Rainfall-runoff simulation
    print("\n" + "=" * 60)
    print("PART 6: SCS-CN RAINFALL-RUNOFF SIMULATION")
    print("=" * 60)
    simulation = simulate_rainfall_runoff(lulc)

    # Part 7: Composite risk scores
    print("\n" + "=" * 60)
    print("PART 7: COMPOSITE FLOOD RISK SCORING")
    print("=" * 60)
    risk_scores = compute_flood_risk_scores(terrain, lulc, drainage, water, buildings)

    # Part 8: Recommendations
    print("\n" + "=" * 60)
    print("PART 8: FLOOD PREVENTION RECOMMENDATIONS")
    print("=" * 60)
    recommendations = generate_recommendations(terrain, lulc, drainage, simulation, risk_scores)
    for rec in recommendations:
        print(f"  [{rec['priority']}] {rec['title']}")
        print(f"    {rec['details'][:120]}...")
        print(f"    Cost: {rec['cost_estimate']} | Timeline: {rec['timeline']}")
        print()

    # Part 9: Map
    print("=" * 60)
    print("PART 9: INTERACTIVE FLOOD RISK MAP")
    print("=" * 60)
    generate_flood_map(terrain, drainage, water, risk_scores,
                       simulation, buildings, recommendations)

    # Save all results
    summary = {
        "event": FLOOD_EVENT,
        "terrain": terrain["stats"] if terrain else None,
        "lulc": lulc if lulc else None,
        "drainage": drainage["stats"] if drainage else None,
        "surface_water": water["stats"] if water else None,
        "building_exposure": buildings["stats"] if buildings else None,
        "simulation": simulation,
        "risk_scores": risk_scores["stats"] if risk_scores else None,
        "recommendations": recommendations,
    }

    summary_path = OUT_DIR / "flood_analysis_summary.json"
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2, default=lambda x: float(x) if hasattr(x, "item") else x)
    log.info("Summary saved: %s", summary_path)

    # Save detailed risk scores
    risk_path = OUT_DIR / "flood_risk_scores.json"
    with open(risk_path, "w") as f:
        json.dump(risk_scores, f, indent=2, default=lambda x: float(x) if hasattr(x, "item") else x)
    log.info("Risk scores saved: %s", risk_path)

    print("\n" + "=" * 60)
    print("ANALYSIS COMPLETE")
    print("=" * 60)
    print(f"  Outputs in: {OUT_DIR}")
    print(f"  - flood_risk_map.html (interactive map)")
    print(f"  - flood_analysis_summary.json")
    print(f"  - flood_risk_scores.json")


if __name__ == "__main__":
    main()
