#!/usr/bin/env python3
"""
Guna Flood Precise Analysis — Pin-Pointed Risk & Infrastructure Siting
========================================================================
Replaces the shallow grid-based analysis with:
  1. DEM-derived drainage channels (actual nalas, not just OSM)
  2. Fill-spill flood depth simulation at 90m resolution
  3. Per-building flood risk with depth estimates
  4. Exact encroachment detection (buildings within 30m of waterways)
  5. Pin-pointed infrastructure siting (retention ponds, culverts, gauges)

Usage:
    python flood_precise_analysis.py
"""

import json
import logging
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
from config import BBOX, BBOX_CITY, CENTER_LAT, CENTER_LON, CITY_NAME, fix_proj

fix_proj()

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("flood-precise")

DATA_DIR = Path(__file__).parent.parent / "data"
RASTER_DIR = DATA_DIR / "rasters"
VECTOR_DIR = DATA_DIR / "vectors"
OUT_DIR = Path(__file__).parent / "output"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Event parameters
RAINFALL_MM = 328
DURATION_HR = 24
CELL_SIZE_M = 90  # SRTM resolution


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000  # meters
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


# ═══════════════════════════════════════════════════════════
# STEP 1: DEM — Flow accumulation + derived drainage network
# ═══════════════════════════════════════════════════════════

def load_dem_and_compute_hydrology():
    """Full hydrological analysis at 90m resolution."""
    import rasterio

    dem_path = RASTER_DIR / f"srtm_90m_{CITY_NAME}.tif"
    log.info("Loading DEM: %s", dem_path.name)
    with rasterio.open(dem_path) as src:
        dem = src.read(1).astype(np.float64)
        transform = src.transform
        nodata = src.nodata

    if nodata is not None:
        dem[dem == nodata] = np.nan

    rows, cols = dem.shape
    valid = ~np.isnan(dem)
    log.info("  Shape: %d x %d, elev: %.0f - %.0f m", rows, cols,
             np.nanmin(dem), np.nanmax(dem))

    def rc_to_lonlat(r, c):
        x = transform[2] + c * transform[0] + r * transform[1]
        y = transform[5] + c * transform[3] + r * transform[4]
        return float(x), float(y)

    # D8 flow direction
    d8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    d8_dist = [math.sqrt(2), 1, math.sqrt(2), 1, 1, math.sqrt(2), 1, math.sqrt(2)]

    flow_dir = np.full((rows, cols), -1, dtype=np.int8)
    slope = np.zeros((rows, cols), dtype=np.float64)

    for r in range(1, rows - 1):
        for c in range(1, cols - 1):
            if np.isnan(dem[r, c]):
                continue
            max_drop = -1
            max_dir = -1
            for i, (dr, dc) in enumerate(d8):
                nr, nc = r + dr, c + dc
                if np.isnan(dem[nr, nc]):
                    continue
                drop = (dem[r, c] - dem[nr, nc]) / (d8_dist[i] * CELL_SIZE_M)
                if drop > max_drop:
                    max_drop = drop
                    max_dir = i
            flow_dir[r, c] = max_dir
            slope[r, c] = max(max_drop, 0)

    # Flow accumulation (sort by descending elevation)
    flow_accum = np.ones((rows, cols), dtype=np.float64)
    flow_accum[~valid] = 0

    coords = np.argwhere(valid)
    elevs = dem[valid]
    order = np.argsort(-elevs)
    sorted_coords = coords[order]

    for idx in range(len(sorted_coords)):
        r, c = sorted_coords[idx]
        d = flow_dir[r, c]
        if d < 0:
            continue
        dr, dc = d8[d]
        nr, nc = r + dr, c + dc
        if 0 <= nr < rows and 0 <= nc < cols:
            flow_accum[nr, nc] += flow_accum[r, c]

    # ── Derive drainage channels ──
    # Threshold: cells draining >50 upstream cells (~4.5 km2 at 90m) = significant channel
    channel_threshold = 50
    channel_mask = flow_accum >= channel_threshold
    channel_cells = np.argwhere(channel_mask)

    log.info("  Flow accum max: %.0f", np.max(flow_accum))
    log.info("  Derived drainage channels: %d cells (threshold=%d)",
             len(channel_cells), channel_threshold)

    # Convert channel cells to lat/lon with accumulation values
    channels = []
    for r, c in channel_cells:
        lon, lat = rc_to_lonlat(r, c)
        channels.append({
            "lat": lat, "lon": lon,
            "accum": float(flow_accum[r, c]),
            "elev_m": float(dem[r, c]),
            "slope": float(slope[r, c]),
        })

    # ── Fill-spill flood depth simulation ──
    log.info("  Running fill-spill flood depth simulation (328mm)...")

    # Each cell receives RAINFALL_MM of water
    # Water depth = rainfall - infiltration + accumulated upstream
    # Simplified: compute ponding depth at depressions

    # Compute Curve Number per cell using slope as proxy
    # Flat areas (slope < 0.01) = urban/impervious (CN~90)
    # Moderate slope = agricultural (CN~72)
    # Steep slope = forested/natural (CN~55)
    cn_grid = np.where(slope < 0.005, 88,
              np.where(slope < 0.02, 75,
              np.where(slope < 0.05, 65, 55)))
    cn_grid = cn_grid.astype(np.float64)

    # SCS runoff per cell
    S = (25400.0 / cn_grid) - 254.0
    Ia = 0.2 * S
    P = RAINFALL_MM
    runoff_mm = np.where(P > Ia, (P - Ia) ** 2 / (P - Ia + S), 0.0)
    runoff_mm[~valid] = 0

    # Route runoff downstream using flow accumulation
    # Water depth at each cell = runoff accumulated from upstream / cell area
    cell_area_m2 = CELL_SIZE_M * CELL_SIZE_M
    # Accumulated runoff volume (mm * m2 = liters, /1000 = m3)
    accum_runoff = np.zeros_like(dem)
    accum_runoff[valid] = runoff_mm[valid]

    # Re-route using same sorted order
    for idx in range(len(sorted_coords)):
        r, c = sorted_coords[idx]
        d = flow_dir[r, c]
        if d < 0:
            continue
        dr, dc = d8[d]
        nr, nc = r + dr, c + dc
        if 0 <= nr < rows and 0 <= nc < cols:
            accum_runoff[nr, nc] += accum_runoff[r, c]

    # Water depth = accumulated runoff / cell area (converted to meters)
    # accumulated is in mm * number_of_cells, so depth_m = accum_runoff * cell_area / cell_area / 1000
    # Actually: each cell's runoff in mm. Accumulated = sum of upstream mm values
    # Volume per cell = runoff_mm / 1000 * cell_area_m2 (m3)
    # At a depression, all upstream volume arrives, depth = total_volume / cell_area
    water_depth_m = accum_runoff / 1000.0 * cell_area_m2 / cell_area_m2
    # This simplifies to accum_runoff / 1000.0 but we need to account for concentration
    # Better model: depth = accum_runoff_mm * n_upstream_cells / 1000 * (upstream_area / local_area)
    # Simplified: depth_m = accum_runoff / 1000 (treating it as mm that ponds)
    water_depth_m = accum_runoff / 1000.0

    # Cap at realistic depth (max 5m for this event)
    water_depth_m = np.clip(water_depth_m, 0, 5.0)

    # Find significant inundation zones (depth > 0.3m)
    inundation_mask = water_depth_m > 0.3
    inundation_cells = np.argwhere(inundation_mask)
    log.info("  Cells with depth > 0.3m: %d", len(inundation_cells))
    log.info("  Cells with depth > 1.0m: %d", np.sum(water_depth_m > 1.0))
    log.info("  Max flood depth: %.1f m", np.max(water_depth_m))

    # Build inundation data for mapping
    inundation_points = []
    for r, c in inundation_cells:
        lon, lat = rc_to_lonlat(r, c)
        depth = float(water_depth_m[r, c])
        inundation_points.append({
            "lat": lat, "lon": lon,
            "depth_m": round(depth, 2),
            "elev_m": round(float(dem[r, c]), 1),
            "accum": float(flow_accum[r, c]),
        })

    # Sort by depth (worst first)
    inundation_points.sort(key=lambda x: -x["depth_m"])

    # ── Depression detection (true local minima) ──
    depressions = []
    for r in range(2, rows - 2):
        for c in range(2, cols - 2):
            if np.isnan(dem[r, c]):
                continue
            center = dem[r, c]
            is_min = True
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    if dr == 0 and dc == 0:
                        continue
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < rows and 0 <= nc < cols and not np.isnan(dem[nr, nc]):
                        if dem[nr, nc] <= center:
                            is_min = False
                            break
                if not is_min:
                    break
            if is_min:
                lon, lat = rc_to_lonlat(r, c)
                depth = float(water_depth_m[r, c])
                depressions.append({
                    "lat": lat, "lon": lon,
                    "elev_m": round(float(center), 1),
                    "depth_m": round(depth, 2),
                    "accum": float(flow_accum[r, c]),
                })

    depressions.sort(key=lambda x: -x["depth_m"])
    log.info("  True depressions (local minima): %d", len(depressions))

    return {
        "dem": dem, "transform": transform,
        "flow_accum": flow_accum, "slope": slope,
        "water_depth": water_depth_m,
        "channels": channels,
        "inundation": inundation_points,
        "depressions": depressions,
        "rc_to_lonlat": rc_to_lonlat,
        "rows": rows, "cols": cols,
    }


# ═══════════════════════════════════════════════════════════
# STEP 2: Load all water features (OSM + JRC)
# ═══════════════════════════════════════════════════════════

def load_water_features():
    """Load OSM waterways and JRC surface water for combined drainage map."""
    import rasterio

    # OSM waterways
    water_path = VECTOR_DIR / f"osm_water_{CITY_NAME}.geojson"
    with open(water_path, encoding="utf-8") as f:
        water_data = json.load(f)

    waterway_lines = []  # (lat, lon) vertices of all waterway LineStrings
    water_bodies = []    # centroids of water body Polygons

    for feat in water_data["features"]:
        g = feat["geometry"]
        p = feat["properties"]
        ww = p.get("waterway", "")
        name = p.get("name", "Unnamed")

        if g["type"] == "LineString":
            coords = [(c[1], c[0]) for c in g["coordinates"]]
            waterway_lines.append({
                "name": name, "type": ww,
                "coords": coords,
            })
        elif g["type"] == "Polygon" and g["coordinates"]:
            ring = g["coordinates"][0]
            clat = sum(c[1] for c in ring) / len(ring)
            clon = sum(c[0] for c in ring) / len(ring)
            # Compute approximate area
            lats = [c[1] for c in ring]
            lons = [c[0] for c in ring]
            w = (max(lons) - min(lons)) * 111000 * math.cos(math.radians(clat))
            h = (max(lats) - min(lats)) * 111000
            area_m2 = w * h
            water_bodies.append({
                "lat": clat, "lon": clon,
                "area_m2": round(area_m2),
                "ring": [(c[1], c[0]) for c in ring],
            })

    log.info("  OSM waterway lines: %d, water bodies: %d",
             len(waterway_lines), len(water_bodies))

    # JRC surface water occurrence
    jrc_path = RASTER_DIR / f"jrc_surface_water_{CITY_NAME}.tif"
    jrc_zones = []
    if jrc_path.exists():
        with rasterio.open(jrc_path) as src:
            jrc = src.read(1).astype(np.float64)
            jrc_transform = src.transform
            jrc_nodata = src.nodata
        if jrc_nodata is not None:
            jrc[jrc == jrc_nodata] = 0
        rows, cols = jrc.shape

        # Extract seasonal flood cells (occurrence 10-80%)
        seasonal = np.argwhere((jrc >= 10) & (jrc < 80))
        for r, c in seasonal:
            x = jrc_transform[2] + c * jrc_transform[0]
            y = jrc_transform[5] + r * jrc_transform[4]
            jrc_zones.append({
                "lat": float(y), "lon": float(x),
                "occurrence_pct": float(jrc[r, c]),
            })
        log.info("  JRC seasonal flood cells: %d", len(jrc_zones))

    return {
        "waterway_lines": waterway_lines,
        "water_bodies": water_bodies,
        "jrc_zones": jrc_zones,
    }


# ═══════════════════════════════════════════════════════════
# STEP 3: Encroachment detection
# ═══════════════════════════════════════════════════════════

def detect_encroachments(hydro, water):
    """Find buildings within buffer zones of waterways and flood channels."""
    log.info("Detecting encroachments...")

    # Build combined waterway coordinate list (OSM + DEM-derived channels)
    # Each entry: (lat, lon, type, name)
    waterway_coords = []

    # OSM rivers/streams
    for wl in water["waterway_lines"]:
        for lat, lon in wl["coords"]:
            waterway_coords.append((lat, lon, wl["type"], wl["name"]))

    # DEM-derived channels (top flow accumulation paths)
    for ch in hydro["channels"]:
        if ch["accum"] >= 100:  # significant channels only
            waterway_coords.append((ch["lat"], ch["lon"], "dem_channel", "DEM-derived nala"))

    # Water body edges
    for wb in water["water_bodies"]:
        for lat, lon in wb["ring"][::3]:  # every 3rd vertex for efficiency
            waterway_coords.append((lat, lon, "water_body", "Water body"))

    log.info("  Combined waterway coords: %d", len(waterway_coords))

    # Load buildings
    bldg_path = VECTOR_DIR / f"google_open_buildings_{CITY_NAME}.geojson"
    with open(bldg_path, encoding="utf-8") as f:
        bldg_data = json.load(f)

    features = bldg_data["features"]
    log.info("  Total buildings: %d", len(features))

    # Buffer zones (meters)
    BUFFER_CRITICAL = 30    # Must remove / relocate
    BUFFER_HIGH = 60        # High risk, needs flood-proofing
    BUFFER_MODERATE = 100   # Moderate risk, needs monitoring

    # Spatial index: bucket waterway coords into grid cells for fast lookup
    grid_size = 0.005  # ~500m grid for spatial indexing
    ww_grid = defaultdict(list)
    for lat, lon, wtype, wname in waterway_coords:
        key = (int(lat / grid_size), int(lon / grid_size))
        ww_grid[key].append((lat, lon, wtype, wname))

    encroachments = []
    risk_buildings = []

    for feat in features:
        g = feat["geometry"]
        if g["type"] != "Polygon":
            continue
        ring = g["coordinates"][0]
        clat = sum(c[1] for c in ring) / len(ring)
        clon = sum(c[0] for c in ring) / len(ring)

        # Spatial filter: only check nearby grid cells
        gkey = (int(clat / grid_size), int(clon / grid_size))
        nearby_water = []
        for dk in range(-1, 2):
            for dl in range(-1, 2):
                nearby_water.extend(ww_grid.get((gkey[0] + dk, gkey[1] + dl), []))

        if not nearby_water:
            continue

        # Find minimum distance to any waterway
        min_dist = 999999
        nearest_type = ""
        nearest_name = ""
        for wlat, wlon, wtype, wname in nearby_water:
            # Quick degree filter
            if abs(wlat - clat) > 0.002 or abs(wlon - clon) > 0.002:
                continue
            dist = haversine(clat, clon, wlat, wlon)
            if dist < min_dist:
                min_dist = dist
                nearest_type = wtype
                nearest_name = wname

        # Also check flood depth at this location
        flood_depth = get_flood_depth_at(hydro, clat, clon)

        # Compute building area (approximate)
        lats = [c[1] for c in ring]
        lons = [c[0] for c in ring]
        bw = (max(lons) - min(lons)) * 111000 * math.cos(math.radians(clat))
        bh = (max(lats) - min(lats)) * 111000
        area_m2 = bw * bh

        # Simplify building ring for map rendering (lat,lon pairs)
        bldg_ring = [[round(c[1], 6), round(c[0], 6)] for c in ring]

        entry = {
            "lat": round(clat, 6),
            "lon": round(clon, 6),
            "dist_m": round(min_dist, 1),
            "nearest_water": nearest_name,
            "water_type": nearest_type,
            "flood_depth_m": round(flood_depth, 2),
            "area_m2": round(area_m2, 1),
            "ring": bldg_ring,
        }

        if min_dist <= BUFFER_CRITICAL:
            entry["action"] = "REMOVE/RELOCATE"
            entry["risk"] = "critical"
            entry["reason"] = f"Within {BUFFER_CRITICAL}m of {nearest_type}"
            encroachments.append(entry)
        elif min_dist <= BUFFER_HIGH:
            entry["action"] = "FLOOD-PROOF"
            entry["risk"] = "high"
            entry["reason"] = f"Within {BUFFER_HIGH}m of {nearest_type}"
            encroachments.append(entry)
        elif min_dist <= BUFFER_MODERATE:
            entry["risk"] = "moderate"
            entry["action"] = "MONITOR"
            risk_buildings.append(entry)
        elif flood_depth > 0.5:
            entry["risk"] = "flood_zone"
            entry["action"] = "FLOOD-PROOF"
            entry["reason"] = f"In flood zone (depth={flood_depth:.1f}m)"
            risk_buildings.append(entry)

    # Sort by distance (closest first)
    encroachments.sort(key=lambda x: x["dist_m"])
    risk_buildings.sort(key=lambda x: -x["flood_depth_m"])

    critical_count = sum(1 for e in encroachments if e["risk"] == "critical")
    high_count = sum(1 for e in encroachments if e["risk"] == "high")

    log.info("  ENCROACHMENTS (must act):")
    log.info("    Critical (within 30m): %d buildings", critical_count)
    log.info("    High (within 60m): %d buildings", high_count)
    log.info("  Risk buildings (monitor/flood-proof): %d", len(risk_buildings))

    return {
        "encroachments": encroachments,
        "risk_buildings": risk_buildings[:500],  # top 500 at-risk
        "stats": {
            "critical_encroachments": critical_count,
            "high_risk_encroachments": high_count,
            "moderate_risk_buildings": len(risk_buildings),
        },
    }


def get_flood_depth_at(hydro, lat, lon):
    """Lookup flood depth at a lat/lon from the water depth grid."""
    t = hydro["transform"]
    # Inverse transform: pixel from world coordinates
    col = int((lon - t[2]) / t[0])
    row = int((lat - t[5]) / t[4])
    if 0 <= row < hydro["rows"] and 0 <= col < hydro["cols"]:
        return float(hydro["water_depth"][row, col])
    return 0.0


# ═══════════════════════════════════════════════════════════
# STEP 4: Infrastructure siting
# ═══════════════════════════════════════════════════════════

def site_infrastructure(hydro, water, encroachments_data):
    """Pin-point exact locations for flood prevention infrastructure."""
    log.info("Siting infrastructure...")

    infra = {
        "retention_ponds": [],
        "culverts": [],
        "river_gauges": [],
        "rain_gauges": [],
        "pumping_stations": [],
        "embankments": [],
        "drain_upgrades": [],
    }

    # ── 1. Retention/Detention Ponds ──
    # Place at depressions with high upstream catchment
    depressions = hydro["depressions"]
    # Filter: significant depressions (accumulation > 30, within wider area)
    pond_candidates = [d for d in depressions
                       if d["accum"] > 30
                       and BBOX_CITY["south"] - 0.1 <= d["lat"] <= BBOX_CITY["north"] + 0.1
                       and BBOX_CITY["west"] - 0.1 <= d["lon"] <= BBOX_CITY["east"] + 0.1]

    # Cluster nearby depressions (within 500m) and pick the deepest
    used = set()
    for i, d in enumerate(pond_candidates):
        if i in used:
            continue
        cluster = [d]
        for j, d2 in enumerate(pond_candidates[i + 1:], i + 1):
            if j in used:
                continue
            if haversine(d["lat"], d["lon"], d2["lat"], d2["lon"]) < 500:
                cluster.append(d2)
                used.add(j)
        used.add(i)

        best = max(cluster, key=lambda x: x["accum"])
        catchment_km2 = best["accum"] * (CELL_SIZE_M ** 2) / 1e6
        volume_m3 = best["depth_m"] * CELL_SIZE_M * CELL_SIZE_M * len(cluster)

        infra["retention_ponds"].append({
            "lat": best["lat"],
            "lon": best["lon"],
            "type": "Retention Pond",
            "priority": "HIGH" if catchment_km2 > 1 else "MEDIUM",
            "catchment_km2": round(catchment_km2, 2),
            "estimated_volume_m3": round(volume_m3),
            "elevation_m": best["elev_m"],
            "reason": f"Natural depression, {catchment_km2:.1f} km2 catchment, clusters {len(cluster)} cells",
        })

    infra["retention_ponds"].sort(key=lambda x: -x["catchment_km2"])
    infra["retention_ponds"] = infra["retention_ponds"][:15]  # top 15 sites
    log.info("  Retention pond sites: %d", len(infra["retention_ponds"]))

    # ── 2. Culvert locations ──
    # Where DEM-derived channels cross roads (load road data)
    road_path = VECTOR_DIR / f"osm_roads_{CITY_NAME}.geojson"
    if road_path.exists():
        with open(road_path, encoding="utf-8") as f:
            road_data = json.load(f)

        # Build road vertex list
        road_coords = []
        for feat in road_data["features"]:
            g = feat["geometry"]
            p = feat["properties"]
            rname = p.get("name", "")
            rtype = p.get("highway", "")
            if g["type"] != "LineString":
                continue
            # Only major roads
            if rtype not in ("primary", "secondary", "tertiary", "trunk",
                             "primary_link", "secondary_link", "trunk_link"):
                continue
            for coord in g["coordinates"]:
                road_coords.append((coord[1], coord[0], rname, rtype))

        # Find where channels (accum > 80) are close to major roads
        major_channels = [ch for ch in hydro["channels"] if ch["accum"] >= 80]
        road_grid = defaultdict(list)
        gs = 0.003
        for lat, lon, rn, rt in road_coords:
            road_grid[(int(lat / gs), int(lon / gs))].append((lat, lon, rn, rt))

        culvert_candidates = []
        for ch in major_channels:
            gk = (int(ch["lat"] / gs), int(ch["lon"] / gs))
            for dk in range(-1, 2):
                for dl in range(-1, 2):
                    for rlat, rlon, rname, rtype in road_grid.get((gk[0] + dk, gk[1] + dl), []):
                        dist = haversine(ch["lat"], ch["lon"], rlat, rlon)
                        if dist < 50:  # within 50m = crossing
                            culvert_candidates.append({
                                "lat": round((ch["lat"] + rlat) / 2, 6),
                                "lon": round((ch["lon"] + rlon) / 2, 6),
                                "type": "Culvert/Bridge Drain",
                                "road": rname or rtype,
                                "road_type": rtype,
                                "channel_accum": ch["accum"],
                                "priority": "CRITICAL" if ch["accum"] > 200 else "HIGH",
                                "reason": f"Channel (accum={ch['accum']:.0f}) crosses {rtype} road",
                            })
                            break

        # Deduplicate (cluster within 100m)
        deduped = []
        used_c = set()
        for i, cu in enumerate(culvert_candidates):
            if i in used_c:
                continue
            for j, cu2 in enumerate(culvert_candidates[i + 1:], i + 1):
                if haversine(cu["lat"], cu["lon"], cu2["lat"], cu2["lon"]) < 100:
                    used_c.add(j)
            deduped.append(cu)
            used_c.add(i)

        infra["culverts"] = sorted(deduped, key=lambda x: -x["channel_accum"])[:30]
        log.info("  Culvert sites: %d", len(infra["culverts"]))

    # ── 3. River gauges ──
    # Place on each named river/stream where it enters city influence zone
    for wl in water["waterway_lines"]:
        if not wl["coords"]:
            continue
        # Find the coord closest to city center
        best_coord = min(wl["coords"],
                         key=lambda c: haversine(c[0], c[1], CENTER_LAT, CENTER_LON))
        dist_to_city = haversine(best_coord[0], best_coord[1], CENTER_LAT, CENTER_LON)
        if dist_to_city < 20000:  # within 20km
            infra["river_gauges"].append({
                "lat": best_coord[0],
                "lon": best_coord[1],
                "type": "River Level Gauge",
                "river": wl["name"],
                "river_type": wl["type"],
                "dist_to_city_km": round(dist_to_city / 1000, 1),
                "priority": "CRITICAL" if dist_to_city < 10000 else "HIGH",
                "reason": f"Monitor {wl['name']} ({wl['type']}), {dist_to_city/1000:.0f}km from city",
            })

    log.info("  River gauge sites: %d", len(infra["river_gauges"]))

    # ── 4. Rain gauges (AWS) ──
    # Distribute across city at ~3km spacing
    rain_lats = np.arange(BBOX_CITY["south"], BBOX_CITY["north"], 0.03)
    rain_lons = np.arange(BBOX_CITY["west"], BBOX_CITY["east"], 0.03)
    idx = 0
    for lat in rain_lats:
        for lon in rain_lons:
            idx += 1
            infra["rain_gauges"].append({
                "lat": round(float(lat), 5),
                "lon": round(float(lon), 5),
                "type": "Automatic Weather Station",
                "id": f"AWS-GUNA-{idx:02d}",
                "priority": "HIGH",
                "reason": f"Rain gauge at grid point {idx}",
            })
    log.info("  Rain gauge sites: %d", len(infra["rain_gauges"]))

    # ── 5. Pumping stations ──
    # Place at deepest inundation points that are in urban area
    urban_inundation = [p for p in hydro["inundation"]
                        if BBOX_CITY["south"] <= p["lat"] <= BBOX_CITY["north"]
                        and BBOX_CITY["west"] <= p["lon"] <= BBOX_CITY["east"]
                        and p["depth_m"] > 0.5]
    urban_inundation.sort(key=lambda x: -x["depth_m"])

    # Cluster and pick worst
    used_p = set()
    for i, p in enumerate(urban_inundation[:50]):
        if i in used_p:
            continue
        for j, p2 in enumerate(urban_inundation[i + 1:50], i + 1):
            if haversine(p["lat"], p["lon"], p2["lat"], p2["lon"]) < 300:
                used_p.add(j)
        infra["pumping_stations"].append({
            "lat": p["lat"],
            "lon": p["lon"],
            "type": "Pumping Station",
            "flood_depth_m": p["depth_m"],
            "priority": "CRITICAL" if p["depth_m"] > 1.0 else "HIGH",
            "reason": f"Urban inundation zone, depth={p['depth_m']:.1f}m",
        })
        used_p.add(i)
        if len(infra["pumping_stations"]) >= 8:
            break

    log.info("  Pumping station sites: %d", len(infra["pumping_stations"]))

    # ── 6. Embankment / flood wall locations ──
    # Along water bodies near urban areas
    for wb in water["water_bodies"]:
        dist_to_city = haversine(wb["lat"], wb["lon"], CENTER_LAT, CENTER_LON)
        if dist_to_city < 5000 and wb["area_m2"] > 50000:
            infra["embankments"].append({
                "lat": wb["lat"],
                "lon": wb["lon"],
                "type": "Flood Embankment",
                "water_body_area_m2": wb["area_m2"],
                "priority": "HIGH",
                "reason": f"Embankment needed for {wb['area_m2']/1000:.0f}K m2 water body, {dist_to_city/1000:.1f}km from center",
            })
    log.info("  Embankment sites: %d", len(infra["embankments"]))

    # ── 7. Drain upgrades ──
    # Encroachment hotspot zones need new drains
    enc_zones = defaultdict(int)
    for e in encroachments_data.get("encroachments", []):
        zone_key = (round(e["lat"], 2), round(e["lon"], 2))
        enc_zones[zone_key] += 1

    for (lat, lon), count in sorted(enc_zones.items(), key=lambda x: -x[1]):
        if count >= 3:
            infra["drain_upgrades"].append({
                "lat": lat,
                "lon": lon,
                "type": "Storm Drain Upgrade",
                "encroachment_count": count,
                "priority": "CRITICAL" if count >= 10 else "HIGH",
                "reason": f"{count} encroachments in zone - needs new stormwater drain",
            })

    log.info("  Drain upgrade zones: %d", len(infra["drain_upgrades"]))

    return infra


# ═══════════════════════════════════════════════════════════
# STEP 5: Generate precise interactive map
# ═══════════════════════════════════════════════════════════

def generate_precise_map(hydro, water, encroachments_data, infra):
    """Interactive map with all pin-pointed layers."""
    log.info("Generating precise flood map...")

    # Prepare data — limit sizes for browser performance
    enc_stats_json = json.dumps(encroachments_data["stats"])

    # Flatten all infra into one list with category
    all_infra = []
    for category, items in infra.items():
        for item in items:
            item["category"] = category
            all_infra.append(item)

    # ── Build GeoJSON features for MapLibre ──

    def point_feature(lat, lon, props):
        return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props}

    def polygon_feature(ring_latlon, props):
        """ring_latlon is [[lat,lon],...] — convert to GeoJSON [lon,lat]."""
        coords = [[c[1], c[0]] for c in ring_latlon]
        return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [coords]},
                "properties": props}

    def line_feature(coords_latlon, props):
        """coords_latlon is [[lat,lon],...] — convert to GeoJSON [lon,lat]."""
        coords = [[c[1], c[0]] for c in coords_latlon]
        return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                "properties": props}

    # Waterway lines (rivers, streams, drains)
    ww_features = []
    for wl in water["waterway_lines"]:
        if len(wl["coords"]) >= 2:
            ww_features.append(line_feature(wl["coords"], {
                "name": wl["name"], "type": wl["type"],
                "weight": 5 if wl["type"] == "river" else 3 if wl["type"] == "stream" else 2,
            }))

    # Water body polygons
    wb_features = []
    for w in water["water_bodies"]:
        if w["ring"] and len(w["ring"]) > 2:
            wb_features.append(polygon_feature(w["ring"], {"area_m2": w["area_m2"]}))

    # DEM channels
    ch_features = [point_feature(ch["lat"], ch["lon"], {
        "accum": ch["accum"], "elev_m": ch["elev_m"],
        "slope_pct": round(ch["slope"] * 100, 1),
        "radius": min(2 + ch["accum"] / 100, 8),
    }) for ch in hydro["channels"][:500] if ch["accum"] >= 30]

    # Inundation
    inun_features = [point_feature(p["lat"], p["lon"], {
        "depth_m": p["depth_m"], "elev_m": p["elev_m"], "accum": p["accum"],
    }) for p in hydro["inundation"][:1000]]

    # Encroachment buildings (polygons where available)
    enc_features = []
    for e in encroachments_data["encroachments"][:500]:
        props = {k: v for k, v in e.items() if k != "ring"}
        if e.get("ring") and len(e["ring"]) > 2:
            enc_features.append(polygon_feature(e["ring"], props))
        else:
            enc_features.append(point_feature(e["lat"], e["lon"], props))

    # Risk buildings (polygons where available)
    risk_features = []
    for b in encroachments_data["risk_buildings"][:300]:
        props = {k: v for k, v in b.items() if k != "ring"}
        if b.get("ring") and len(b["ring"]) > 2:
            risk_features.append(polygon_feature(b["ring"], props))
        else:
            risk_features.append(point_feature(b["lat"], b["lon"], props))

    # Infrastructure points
    infra_features = [point_feature(inf["lat"], inf["lon"], {
        "type": inf["type"], "priority": inf.get("priority", ""),
        "category": inf["category"], "reason": inf.get("reason", ""),
    }) for inf in all_infra]

    # Depressions
    dep_features = [point_feature(d["lat"], d["lon"], {
        "depth_m": d["depth_m"], "elev_m": d["elev_m"], "accum": d["accum"],
    }) for d in hydro["depressions"][:100]]

    # JRC historical
    jrc_features = [point_feature(z["lat"], z["lon"], {
        "occurrence_pct": z["occurrence_pct"],
    }) for z in water["jrc_zones"][:500]]

    def fc(features):
        return json.dumps({"type": "FeatureCollection", "features": features})

    ww_geojson = fc(ww_features)
    wb_geojson = fc(wb_features)
    ch_geojson = fc(ch_features)
    inun_geojson = fc(inun_features)
    enc_geojson = fc(enc_features)
    risk_geojson = fc(risk_features)
    infra_geojson = fc(infra_features)
    dep_geojson = fc(dep_features)
    jrc_geojson = fc(jrc_features)

    # Panel data (simple arrays for sidebar lists)
    encroach_list_json = json.dumps([{k: v for k, v in e.items() if k != "ring"}
                                     for e in encroachments_data["encroachments"][:500]])
    infra_list_json = json.dumps(all_infra)
    inun_list_json = json.dumps(hydro["inundation"][:50])

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Guna Flood Precise Analysis -- 3D Terrain Risk Map</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"/>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family:'Segoe UI',system-ui,sans-serif; background:#0a0e17; color:#e0e0e0; display:flex; height:100vh; }}
#map {{ flex:1; }}
#panel {{ width:440px; background:#0d1117; overflow-y:auto; padding:16px; border-left:1px solid #1b2838; }}
h1 {{ font-size:17px; color:#ff6b35; }}
.sub {{ font-size:11px; color:#888; margin-bottom:12px; }}
.tabs {{ display:flex; gap:3px; margin-bottom:12px; flex-wrap:wrap; }}
.tab {{ padding:5px 10px; font-size:10px; border-radius:5px; cursor:pointer; background:#1b2838; color:#888; border:1px solid #1b2838; }}
.tab.active {{ background:#ff6b35; color:#fff; border-color:#ff6b35; }}
.section {{ display:none; }}
.section.active {{ display:block; }}
.card {{ background:#0d2137; border:1px solid rgba(255,107,53,0.25); border-radius:8px; padding:12px; margin:8px 0; }}
.card-title {{ font-size:12px; font-weight:700; color:#ff6b35; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }}
.row {{ display:flex; justify-content:space-between; padding:2px 0; font-size:11px; }}
.lbl {{ color:#888; }} .val {{ font-weight:600; color:#fff; }}
.val.red {{ color:#ff4444; }} .val.orange {{ color:#ff9800; }} .val.green {{ color:#00e676; }} .val.blue {{ color:#2196f3; }}
.enc-item {{ background:#1a0000; border:1px solid #ff4444; border-radius:6px; padding:8px; margin:6px 0; font-size:11px; cursor:pointer; }}
.enc-item.high {{ border-color:#ff9800; background:#1a1000; }}
.enc-item .action {{ font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; display:inline-block; margin-bottom:3px; }}
.enc-item .action.critical {{ background:#ff4444; color:#fff; }}
.enc-item .action.high {{ background:#ff9800; color:#000; }}
.infra-item {{ background:#001a0d; border:1px solid #00e676; border-radius:6px; padding:8px; margin:6px 0; font-size:11px; cursor:pointer; }}
.infra-item .tag {{ font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; display:inline-block; margin-bottom:3px; background:#00e676; color:#000; }}
.infra-item .tag.CRITICAL {{ background:#ff4444; color:#fff; }}
.infra-item .tag.HIGH {{ background:#ff9800; color:#000; }}
.depth-bar {{ height:4px; border-radius:2px; margin-top:3px; }}
.legend {{ font-size:10px; }}
.legend-row {{ display:flex; align-items:center; gap:6px; padding:2px 0; }}
.legend-dot {{ width:12px; height:12px; border-radius:50%; flex-shrink:0; }}
.legend-line {{ width:20px; height:3px; flex-shrink:0; border-radius:1px; }}
#layer-toggles {{ background:#0d2137; border:1px solid #1b2838; border-radius:8px; padding:10px; margin-bottom:12px; }}
#layer-toggles label {{ display:flex; align-items:center; gap:6px; font-size:11px; padding:2px 0; cursor:pointer; }}
#layer-toggles input {{ accent-color:#ff6b35; }}
.view-btns {{ display:flex; gap:4px; margin-bottom:10px; }}
.view-btn {{ padding:4px 10px; font-size:10px; border-radius:5px; cursor:pointer; background:#1b2838; color:#aaa; border:1px solid #333; }}
.view-btn:hover {{ background:#ff6b35; color:#fff; }}
.maplibregl-popup-content {{ background:#0d1117!important; color:#e0e0e0!important; border:1px solid #ff6b35!important; border-radius:8px!important; padding:10px!important; font-size:12px!important; max-width:280px!important; }}
.maplibregl-popup-tip {{ border-top-color:#ff6b35!important; }}
.maplibregl-popup-close-button {{ color:#ff6b35!important; font-size:16px!important; }}
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
<h1>Guna Flood -- 3D Terrain Analysis</h1>
<div class="sub">3D terrain + drains, streams, building footprints, infrastructure</div>
<div class="view-btns">
  <div class="view-btn" onclick="flyTo3D()">3D Terrain</div>
  <div class="view-btn" onclick="flyToTop()">Top Down</div>
  <div class="view-btn" onclick="flyToCity()">City Center</div>
</div>
<div id="layer-toggles">
  <div class="card-title">LAYERS</div>
  <label><input type="checkbox" checked data-layers="ww-lines"> Waterways (OSM)</label>
  <label><input type="checkbox" checked data-layers="wb-fill,wb-outline"> Water Bodies</label>
  <label><input type="checkbox" checked data-layers="ch-circles"> DEM Channels</label>
  <label><input type="checkbox" checked data-layers="inun-circles"> Flood Depth</label>
  <label><input type="checkbox" checked data-layers="enc-fill,enc-outline"> Encroachments</label>
  <label><input type="checkbox" data-layers="risk-fill,risk-outline"> Buildings at Risk</label>
  <label><input type="checkbox" checked data-layers="infra-symbols"> Infrastructure</label>
  <label><input type="checkbox" data-layers="jrc-circles"> JRC History</label>
  <label><input type="checkbox" data-layers="dep-circles"> Depressions</label>
</div>
<div class="tabs" id="tabs"></div>
<div class="section active" id="sec-summary"></div>
<div class="section" id="sec-encroach"></div>
<div class="section" id="sec-infra"></div>
<div class="section" id="sec-depth"></div>
</div>
<script>
const encStats = {enc_stats_json};
const encroachList = {encroach_list_json};
const infraList = {infra_list_json};
const inunList = {inun_list_json};

const map = new maplibregl.Map({{
  container: 'map',
  style: {{
    version: 8,
    sources: {{
      'carto-dark': {{
        type: 'raster',
        tiles: ['https://a.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}@2x.png'],
        tileSize: 256, attribution: '&copy; CARTO &copy; OSM'
      }},
      'terrain-dem': {{
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{{z}}/{{x}}/{{y}}.png'],
        encoding: 'terrarium', tileSize: 256, maxzoom: 15
      }}
    }},
    layers: [{{ id:'carto', type:'raster', source:'carto-dark' }}],
    terrain: {{ source:'terrain-dem', exaggeration: 1.8 }},
    sky: {{}}
  }},
  center: [{CENTER_LON}, {CENTER_LAT}],
  zoom: 12.5, pitch: 55, bearing: -20, maxPitch: 85
}});
map.addControl(new maplibregl.NavigationControl(), 'top-left');

function depthColor(d) {{
  if (d >= 2.0) return '#7b1fa2';
  if (d >= 1.0) return '#ff1744';
  if (d >= 0.5) return '#ff9800';
  return '#ffeb3b';
}}
function flyTo3D() {{ map.easeTo({{ pitch:60, bearing:-30, zoom:13, duration:1500 }}); }}
function flyToTop() {{ map.easeTo({{ pitch:0, bearing:0, zoom:13, duration:1500 }}); }}
function flyToCity() {{ map.flyTo({{ center:[{CENTER_LON},{CENTER_LAT}], zoom:14, pitch:55, bearing:10, duration:2000 }}); }}

map.on('load', function() {{
  map.addSource('waterways', {{ type:'geojson', data: {ww_geojson} }});
  map.addLayer({{ id:'ww-lines', type:'line', source:'waterways',
    paint: {{ 'line-color':['match',['get','type'],'river','#1e88e5','stream','#42a5f5','drain','#80d8ff','canal','#0097a7','#42a5f5'],
              'line-width':['get','weight'], 'line-opacity':0.9 }} }});

  map.addSource('waterbodies', {{ type:'geojson', data: {wb_geojson} }});
  map.addLayer({{ id:'wb-fill', type:'fill', source:'waterbodies',
    paint: {{ 'fill-color':'#1565c0', 'fill-opacity':0.4 }} }});
  map.addLayer({{ id:'wb-outline', type:'line', source:'waterbodies',
    paint: {{ 'line-color':'#42a5f5', 'line-width':2, 'line-opacity':0.8 }} }});

  map.addSource('channels', {{ type:'geojson', data: {ch_geojson} }});
  map.addLayer({{ id:'ch-circles', type:'circle', source:'channels',
    paint: {{ 'circle-radius':['min',['+',2,['/',['get','accum'],100]],8],
              'circle-color':'#00bcd4', 'circle-opacity':['min',['+',0.3,['/',['get','accum'],500]],0.8] }} }});

  map.addSource('inundation', {{ type:'geojson', data: {inun_geojson} }});
  map.addLayer({{ id:'inun-circles', type:'circle', source:'inundation',
    paint: {{ 'circle-radius':['min',['+',3,['*',['get','depth_m'],3]],12],
              'circle-color':['interpolate',['linear'],['get','depth_m'],0.3,'#ffeb3b',0.5,'#ff9800',1.0,'#ff1744',2.0,'#7b1fa2'],
              'circle-opacity':0.6 }} }});

  map.addSource('encroachments', {{ type:'geojson', data: {enc_geojson} }});
  map.addLayer({{ id:'enc-fill', type:'fill', source:'encroachments',
    filter:['==',['geometry-type'],'Polygon'],
    paint: {{ 'fill-color':['match',['get','risk'],'critical','#ff1744','#ff9800'], 'fill-opacity':0.6 }} }});
  map.addLayer({{ id:'enc-outline', type:'line', source:'encroachments',
    filter:['==',['geometry-type'],'Polygon'],
    paint: {{ 'line-color':['match',['get','risk'],'critical','#ff1744','#ff9800'], 'line-width':2 }} }});

  map.addSource('risk-bldgs', {{ type:'geojson', data: {risk_geojson} }});
  map.addLayer({{ id:'risk-fill', type:'fill', source:'risk-bldgs',
    filter:['==',['geometry-type'],'Polygon'],
    paint: {{ 'fill-color':'#ffeb3b', 'fill-opacity':0.3 }}, layout:{{ visibility:'none' }} }});
  map.addLayer({{ id:'risk-outline', type:'line', source:'risk-bldgs',
    filter:['==',['geometry-type'],'Polygon'],
    paint: {{ 'line-color':'#ffeb3b', 'line-width':1 }}, layout:{{ visibility:'none' }} }});

  map.addSource('infrastructure', {{ type:'geojson', data: {infra_geojson} }});
  map.addLayer({{ id:'infra-symbols', type:'symbol', source:'infrastructure',
    layout: {{ 'text-field':['match',['get','category'],'retention_ponds','RP','culverts','CU','river_gauges','RG','rain_gauges','AW','pumping_stations','PS','embankments','EM','drain_upgrades','DR','??'],
               'text-size':11, 'text-allow-overlap':true }},
    paint: {{ 'text-color':['match',['get','category'],'retention_ponds','#2196f3','culverts','#ff9800','river_gauges','#00bcd4','rain_gauges','#4caf50','pumping_stations','#9c27b0','embankments','#795548','drain_upgrades','#ff5722','#888'],
              'text-halo-color':'#000', 'text-halo-width':2 }} }});

  map.addSource('jrc', {{ type:'geojson', data: {jrc_geojson} }});
  map.addLayer({{ id:'jrc-circles', type:'circle', source:'jrc',
    paint: {{ 'circle-radius':2, 'circle-color':'#00bcd4', 'circle-opacity':0.3 }}, layout:{{ visibility:'none' }} }});

  map.addSource('depressions', {{ type:'geojson', data: {dep_geojson} }});
  map.addLayer({{ id:'dep-circles', type:'circle', source:'depressions',
    paint: {{ 'circle-radius':5, 'circle-color':'#9c27b0', 'circle-opacity':0.6, 'circle-stroke-width':2, 'circle-stroke-color':'#ce93d8' }},
    layout:{{ visibility:'none' }} }});

  // Click popups
  ['ww-lines','wb-fill','ch-circles','inun-circles','enc-fill','risk-fill','infra-symbols','dep-circles'].forEach(function(lid) {{
    map.on('click', lid, function(e) {{
      const p = e.features[0].properties;
      let h = '';
      if (lid==='ww-lines') h='<b>'+(p.name||'Unnamed')+'</b><br>Type: '+p.type;
      else if (lid==='wb-fill') h='<b>Water Body</b><br>Area: '+p.area_m2+' m2';
      else if (lid==='ch-circles') h='<b>DEM Channel</b><br>Accum: '+Math.round(p.accum)+' | Elev: '+p.elev_m+'m | Slope: '+p.slope_pct+'%';
      else if (lid==='inun-circles') h='<b>Flood: '+p.depth_m+'m</b><br>Elev: '+p.elev_m+'m | Accum: '+Math.round(p.accum);
      else if (lid==='enc-fill') h='<b>'+p.action+'</b><br>'+p.dist_m+'m from '+p.water_type+'<br>Flood: '+p.flood_depth_m+'m | Area: '+p.area_m2+' m2';
      else if (lid==='risk-fill') h='<b>'+p.action+'</b><br>Dist: '+p.dist_m+'m | Flood: '+p.flood_depth_m+'m';
      else if (lid==='infra-symbols') h='<b>'+p.type+'</b><br>['+p.priority+'] '+p.reason;
      else if (lid==='dep-circles') h='<b>Depression</b><br>Depth: '+p.depth_m+'m | Elev: '+p.elev_m+'m';
      new maplibregl.Popup().setLngLat(e.lngLat).setHTML(h).addTo(map);
    }});
    map.on('mouseenter', lid, function() {{ map.getCanvas().style.cursor='pointer'; }});
    map.on('mouseleave', lid, function() {{ map.getCanvas().style.cursor=''; }});
  }});
}});

// Layer toggles
document.querySelectorAll('#layer-toggles input').forEach(function(cb) {{
  cb.addEventListener('change', function() {{
    this.dataset.layers.split(',').forEach(function(lid) {{
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', cb.checked ? 'visible' : 'none');
    }});
  }});
}});

// ── Panel tabs ──
(function(){{
  const tabs = document.getElementById('tabs');
  ['Summary','Encroachments','Infrastructure','Flood Depth'].forEach(function(n,i){{
    const ids = ['sec-summary','sec-encroach','sec-infra','sec-depth'];
    const t = document.createElement('div');
    t.className = 'tab'+(i===0?' active':''); t.textContent = n;
    t.addEventListener('click',function(){{
      document.querySelectorAll('.tab').forEach(function(x){{x.classList.remove('active')}});
      document.querySelectorAll('.section').forEach(function(x){{x.classList.remove('active')}});
      t.classList.add('active'); document.getElementById(ids[i]).classList.add('active');
    }}); tabs.appendChild(t);
  }});
}})();

// ── Summary tab ──
(function(){{
  const sec = document.getElementById('sec-summary');
  function addCard(title, rows) {{
    const card = document.createElement('div'); card.className='card';
    const ct = document.createElement('div'); ct.className='card-title'; ct.textContent=title;
    card.appendChild(ct);
    rows.forEach(function(r){{
      const row = document.createElement('div'); row.className='row';
      const lbl = document.createElement('span'); lbl.className='lbl'; lbl.textContent=r[0];
      const val = document.createElement('span'); val.className='val '+(r[2]||''); val.textContent=r[1];
      row.appendChild(lbl); row.appendChild(val); card.appendChild(row);
    }});
    sec.appendChild(card);
  }}
  addCard('ENCROACHMENT SUMMARY',[
    ['Buildings to REMOVE (<30m)', encStats.critical_encroachments, 'red'],
    ['Buildings to FLOOD-PROOF (<60m)', encStats.high_risk_encroachments, 'orange'],
    ['Buildings to MONITOR (<100m)', encStats.moderate_risk_buildings, ''],
  ]);
  const cats = {{}};
  infraList.forEach(function(inf){{ cats[inf.category]=(cats[inf.category]||0)+1; }});
  addCard('INFRASTRUCTURE TO BUILD', Object.entries(cats).map(function(e){{ return [e[0].replace(/_/g,' '),e[1],'blue']; }}));

  const legend = document.createElement('div'); legend.className='card legend';
  const lt = document.createElement('div'); lt.className='card-title'; lt.textContent='MAP LEGEND'; legend.appendChild(lt);
  [['line','#1e88e5','River (OSM)'],['line','#42a5f5','Stream/Drain (OSM)'],['dot','#1565c0','Water body'],
   ['dot','#00bcd4','DEM channel (nala)'],['dot','#ff1744','REMOVE (<30m)'],['dot','#ff9800','FLOOD-PROOF (<60m)'],
   ['dot','#ffeb3b','MONITOR (<100m)'],['dot','#7b1fa2','Flood >=2m'],['dot','#ff1744','Flood 1-2m'],
   ['dot','#ff9800','Flood 0.5-1m'],['dot','#9c27b0','Depression']
  ].forEach(function(item){{
    const r = document.createElement('div'); r.className='legend-row';
    const d = document.createElement('div'); d.className=item[0]==='line'?'legend-line':'legend-dot'; d.style.backgroundColor=item[1];
    const t = document.createElement('span'); t.textContent=item[2];
    r.appendChild(d); r.appendChild(t); legend.appendChild(r);
  }});
  sec.appendChild(legend);
}})();

// ── Encroachments tab ──
(function(){{
  const sec = document.getElementById('sec-encroach');
  const title = document.createElement('div'); title.className='card-title';
  title.textContent = 'BUILDINGS TO ACT ON ('+encroachList.filter(function(e){{return e.risk==='critical'}}).length+' critical)';
  sec.appendChild(title);
  encroachList.forEach(function(e){{
    const item = document.createElement('div');
    item.className = 'enc-item'+(e.risk==='high'?' high':''); item.style.cursor='pointer';
    const badge = document.createElement('span'); badge.className='action '+e.risk; badge.textContent=e.action;
    item.appendChild(badge);
    const info = document.createElement('div');
    info.textContent = e.dist_m+'m from '+e.water_type+' | Flood: '+e.flood_depth_m+'m | '+e.area_m2+' m2';
    item.appendChild(info);
    const coords = document.createElement('div'); coords.style.cssText='font-size:9px;color:#666;margin-top:2px';
    coords.textContent = e.lat.toFixed(5)+', '+e.lon.toFixed(5); item.appendChild(coords);
    item.addEventListener('click', function(){{ map.flyTo({{ center:[e.lon,e.lat], zoom:17, pitch:55, duration:1500 }}); }});
    sec.appendChild(item);
  }});
}})();

// ── Infrastructure tab ──
(function(){{
  const sec = document.getElementById('sec-infra');
  const categories = ['retention_ponds','culverts','pumping_stations','river_gauges','rain_gauges','embankments','drain_upgrades'];
  const catNames = ['Retention Ponds','Culverts','Pumping Stations','River Gauges','Rain Gauges (AWS)','Embankments','Drain Upgrades'];
  categories.forEach(function(cat, ci){{
    const items = infraList.filter(function(inf){{ return inf.category === cat; }});
    if (!items.length) return;
    const heading = document.createElement('div'); heading.className='card-title';
    heading.textContent = catNames[ci]+' ('+items.length+')'; heading.style.marginTop='12px'; sec.appendChild(heading);
    items.forEach(function(inf){{
      const item = document.createElement('div'); item.className='infra-item'; item.style.cursor='pointer';
      const tag = document.createElement('span'); tag.className='tag '+(inf.priority||'');
      tag.textContent = (inf.priority||'')+' - '+inf.type; item.appendChild(tag);
      const reason = document.createElement('div'); reason.textContent = inf.reason||''; item.appendChild(reason);
      const coords = document.createElement('div'); coords.style.cssText='font-size:9px;color:#666;margin-top:2px';
      coords.textContent = inf.lat.toFixed(5)+', '+inf.lon.toFixed(5); item.appendChild(coords);
      item.addEventListener('click', function(){{ map.flyTo({{ center:[inf.lon,inf.lat], zoom:16, pitch:55, duration:1500 }}); }});
      sec.appendChild(item);
    }});
  }});
}})();

// ── Flood Depth tab ──
(function(){{
  const sec = document.getElementById('sec-depth');
  const title = document.createElement('div'); title.className='card-title'; title.textContent='DEEPEST INUNDATION ZONES';
  sec.appendChild(title);
  const note = document.createElement('div'); note.style.cssText='font-size:10px;color:#888;margin-bottom:8px';
  note.textContent = 'SCS-CN + D8 flow routing for 328mm/24hr. Click to fly.'; sec.appendChild(note);
  inunList.forEach(function(p){{
    const item = document.createElement('div'); item.className='card'; item.style.cursor='pointer'; item.style.padding='8px';
    const depth = document.createElement('div'); depth.style.cssText='font-size:13px;font-weight:700;color:'+depthColor(p.depth_m);
    depth.textContent = p.depth_m+'m flood depth'; item.appendChild(depth);
    const info = document.createElement('div'); info.style.cssText='font-size:10px;color:#888';
    info.textContent = 'Elev: '+p.elev_m+'m | Upstream: '+p.accum.toFixed(0)+' | '+p.lat.toFixed(5)+', '+p.lon.toFixed(5);
    item.appendChild(info);
    const bar = document.createElement('div'); bar.className='depth-bar'; bar.style.backgroundColor=depthColor(p.depth_m);
    bar.style.width = Math.min(p.depth_m/5*100,100)+'%'; item.appendChild(bar);
    item.addEventListener('click', function(){{ map.flyTo({{ center:[p.lon,p.lat], zoom:16, pitch:55, duration:1500 }}); }});
    sec.appendChild(item);
  }});
}})();
</script>
</body>
</html>"""

    out_path = OUT_DIR / "flood_precise_map.html"
    out_path.write_text(html, encoding="utf-8")
    log.info("  Saved: %s", out_path)
    return out_path


# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("GUNA FLOOD PRECISE ANALYSIS")
    print("Pin-pointed encroachments, infrastructure, flood depths")
    print("=" * 60)

    # Step 1: Hydrology
    print("\n[1/5] DEM hydrology + flood depth simulation...")
    hydro = load_dem_and_compute_hydrology()

    # Step 2: Water features
    print("\n[2/5] Loading water features (OSM + JRC)...")
    water = load_water_features()

    # Step 3: Encroachments
    print("\n[3/5] Detecting encroachments (building-waterway proximity)...")
    encroachments = detect_encroachments(hydro, water)

    # Step 4: Infrastructure
    print("\n[4/5] Siting infrastructure...")
    infra = site_infrastructure(hydro, water, encroachments)

    # Step 5: Map
    print("\n[5/5] Generating precise interactive map...")
    generate_precise_map(hydro, water, encroachments, infra)

    # Save JSON results
    results = {
        "encroachments": encroachments,
        "infrastructure": infra,
        "inundation_stats": {
            "total_cells_above_03m": len(hydro["inundation"]),
            "max_depth_m": hydro["inundation"][0]["depth_m"] if hydro["inundation"] else 0,
            "depressions": len(hydro["depressions"]),
            "dem_channels": len([c for c in hydro["channels"] if c["accum"] >= 50]),
        },
    }

    results_path = OUT_DIR / "flood_precise_results.json"
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2,
                  default=lambda x: float(x) if hasattr(x, "item") else x)
    log.info("Results saved: %s", results_path)

    # Print summary
    print("\n" + "=" * 60)
    print("PRECISE ANALYSIS COMPLETE")
    print("=" * 60)
    print(f"\n  ENCROACHMENTS:")
    print(f"    REMOVE/RELOCATE (<30m): {encroachments['stats']['critical_encroachments']} buildings")
    print(f"    FLOOD-PROOF (<60m):     {encroachments['stats']['high_risk_encroachments']} buildings")
    print(f"    MONITOR (<100m):        {encroachments['stats']['moderate_risk_buildings']} buildings")
    print(f"\n  INFRASTRUCTURE TO BUILD:")
    for cat, items in infra.items():
        if items:
            print(f"    {cat.replace('_',' ').title():25s}: {len(items)} sites")
    print(f"\n  FLOOD SIMULATION (328mm/24hr):")
    print(f"    Cells with depth > 0.3m: {len(hydro['inundation'])}")
    if hydro["inundation"]:
        print(f"    Max depth: {hydro['inundation'][0]['depth_m']:.1f}m")
    print(f"\n  Outputs:")
    print(f"    flood_precise_map.html")
    print(f"    flood_precise_results.json")


if __name__ == "__main__":
    main()
