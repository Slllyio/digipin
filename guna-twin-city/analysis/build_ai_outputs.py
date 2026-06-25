"""Generate the AI-layer GeoJSONs for the Guna map from local data.

The Guna page's AI Layers panel (js/ai-layers.js) fetches six GeoJSONs from
data/ai_outputs/. Guna never had them (all 404 -> blank). This computes real
ones from data we already have:

  lulc_guna.geojson      <- ESA WorldCover 10m   (per-cell dominant class)
  ndvi_guna.geojson      <- Sentinel-2 (B08-B04)/(B08+B04)
  changes_guna.geojson   <- NDVI delta between the two Sentinel-2 dates
  flood_extent_guna.geojson <- flood_risk_scores.json zones (probability+depth)
  buildings_ai_guna.geojson <- Google Open Buildings footprints (+est height/type)
  crowd_density_guna.geojson <- building density per cell -> ppl/cell

Schemas match what ai-layers.js reads: lulc.class, ndvi.ndvi, flood.probability/
depth_m, changes.change_type, buildings_ai.building_type/height, crowd.density.

Run:  PYTHONPATH=guna-twin-city/pipeline python guna-twin-city/analysis/build_ai_outputs.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # guna-twin-city/
RASTER = ROOT / "data" / "rasters"
VECTOR = ROOT / "data" / "vectors"
SAT = ROOT / "data" / "satellite" / "sentinel2_guna"
OUT = ROOT / "data" / "ai_outputs"
ANALYSIS_OUT = Path(__file__).resolve().parent / "output"

# Focused city-core grid (≈250 m cells over ~15 km around Guna centre).
CENTER = (24.6354, 77.3126)
HALF = 0.075                      # ~8 km half-extent
NX = NY = 60                      # 60x60 = 3600 cells, ~250 m each
WEST, EAST = CENTER[1] - HALF, CENTER[1] + HALF
SOUTH, NORTH = CENTER[0] - HALF, CENTER[0] + HALF

# ESA WorldCover code -> ai-layers LULC class
WC_TO_CLASS = {
    10: "trees", 20: "grass", 30: "grass", 40: "crops", 50: "built",
    60: "bare", 70: "bare", 80: "water", 90: "water", 95: "trees", 100: "bare",
}


def _grid_transform():
    from rasterio.transform import from_bounds
    return from_bounds(WEST, SOUTH, EAST, NORTH, NX, NY)


_DST_CRS = None


def _dst_crs():
    """WGS84 geographic CRS built via pyproj WKT — sidesteps the broken EPSG
    db lookup that the literal 'EPSG:4326' string triggers on this Windows box."""
    global _DST_CRS
    if _DST_CRS is None:
        import pyproj
        from rasterio.crs import CRS
        _DST_CRS = CRS.from_wkt(pyproj.CRS.from_epsg(4326).to_wkt())
    return _DST_CRS


def _cell_polygon(c, r):
    """Square polygon for grid column c, row r (row 0 = north)."""
    dx = (EAST - WEST) / NX
    dy = (NORTH - SOUTH) / NY
    x0 = WEST + c * dx
    y1 = NORTH - r * dy
    x1, y0 = x0 + dx, y1 - dy
    return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]


def _resample(path, resampling, band=1):
    """Reproject a source raster onto the city-core grid -> (NY, NX) float array."""
    import numpy as np
    import rasterio
    from rasterio.warp import reproject

    dst = np.zeros((NY, NX), dtype="float32")
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, band), destination=dst,
            dst_transform=_grid_transform(), dst_crs=_dst_crs(),
            resampling=resampling,
        )
    return dst


def _fc(features):
    return {"type": "FeatureCollection", "features": features}


def _write(name, fc):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(fc), encoding="utf-8")
    return len(fc["features"])


# ── LULC (WorldCover -> dominant class per cell) ───────────────────────
def build_lulc():
    from rasterio.warp import Resampling
    wc = _resample(RASTER / "worldcover_10m_guna.tif", Resampling.mode).astype("int32")
    feats = []
    for r in range(NY):
        for c in range(NX):
            klass = WC_TO_CLASS.get(int(wc[r, c]))
            if not klass:
                continue
            feats.append({"type": "Feature",
                          "geometry": {"type": "Polygon", "coordinates": _cell_polygon(c, r)},
                          "properties": {"class": klass}})
    return _write("lulc_guna.geojson", _fc(feats))


# ── NDVI (Sentinel-2) ──────────────────────────────────────────────────
def _ndvi_grid(date):
    import numpy as np
    from rasterio.warp import Resampling
    red = _resample(SAT / f"guna_{date}_B04.tif", Resampling.bilinear)
    nir = _resample(SAT / f"guna_{date}_B08.tif", Resampling.bilinear)
    denom = nir + red
    ndvi = np.where(denom > 0, (nir - red) / denom, 0.0)
    return np.clip(ndvi, -1.0, 1.0)


def build_ndvi():
    ndvi = _ndvi_grid("2025-10-20")
    feats = []
    for r in range(NY):
        for c in range(NX):
            v = float(ndvi[r, c])
            if v <= 0:                          # skip water/bare/no-data to keep it lean
                continue
            feats.append({"type": "Feature",
                          "geometry": {"type": "Polygon", "coordinates": _cell_polygon(c, r)},
                          "properties": {"ndvi": round(v, 3)}})
    return _write("ndvi_guna.geojson", _fc(feats))


# ── Change detection (NDVI delta between the two dates) ─────────────────
def build_changes():
    a = _ndvi_grid("2025-10-20")
    b = _ndvi_grid("2026-03-16")
    feats = []
    for r in range(NY):
        for c in range(NX):
            d = float(b[r, c] - a[r, c])
            if d <= -0.18:
                ct = "construction"           # vegetation lost -> likely built-up
            elif d >= 0.22:
                ct = "other"                  # greening / regrowth
            else:
                continue                       # no significant change
            feats.append({"type": "Feature",
                          "geometry": {"type": "Polygon", "coordinates": _cell_polygon(c, r)},
                          "properties": {"change_type": ct, "ndvi_delta": round(d, 3)}})
    return _write("changes_guna.geojson", _fc(feats))


# ── Flood extent (from flood_risk_scores zones) ────────────────────────
def build_flood():
    src = ANALYSIS_OUT / "flood_risk_scores.json"
    if not src.exists():
        return _write("flood_extent_guna.geojson", _fc([]))
    zones = json.loads(src.read_text(encoding="utf-8")).get("zones", [])
    h = 0.0025
    feats = []
    for z in zones:
        score = float(z.get("risk_score", 0) or 0)
        if score <= 0:
            continue
        lat, lon = z["lat"], z["lon"]
        prob = round(min(1.0, score / 40.0), 3)
        feats.append({"type": "Feature",
                      "geometry": {"type": "Polygon", "coordinates":
                          [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h],
                            [lon - h, lat + h], [lon - h, lat - h]]]},
                      "properties": {"probability": prob,
                                     "depth_m": round(min(3.0, score / 13.0), 2)}})
    return _write("flood_extent_guna.geojson", _fc(feats))


# ── Buildings (Google Open Buildings + estimated height/type) ──────────
def build_buildings():
    src = VECTOR / "google_open_buildings_guna.geojson"
    if not src.exists():
        return _write("buildings_ai_guna.geojson", _fc([]))
    data = json.loads(src.read_text(encoding="utf-8"))
    src_feats = data.get("features", [])
    # Cap to keep the committed GeoJSON lean; sample evenly across the set.
    MAX_BUILDINGS = 7000
    step = max(1, len(src_feats) // MAX_BUILDINGS)
    feats = []
    for f in src_feats[::step]:
        geom = f.get("geometry")
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        # centroid quick-reject to the core bbox
        try:
            ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
        except Exception:
            continue
        if not (WEST <= cx <= EAST and SOUTH <= cy <= NORTH):
            continue
        area = float(f.get("properties", {}).get("area_in_meters")
                     or f.get("properties", {}).get("area_m2") or 0)
        if area <= 0:
            area = _ring_area_m2(ring, cy)
        floors = max(1, min(8, int(area / 90) + 1))     # rough: bigger footprint -> taller
        height = round(floors * 3.0, 1)
        btype = "residential" if area < 150 else "commercial" if area < 600 else "industrial"
        # round coords to ~0.1 m to keep the file lean
        g = _round_geom(geom)
        feats.append({"type": "Feature", "geometry": g,
                      "properties": {"building_type": btype, "height": height,
                                     "floors": floors, "area_m2": round(area)}})
    return _write("buildings_ai_guna.geojson", _fc(feats))


def _ring_area_m2(ring, lat):
    # shoelace in degrees -> m^2 (local scale)
    mlat = 111132.0
    mlon = 111320.0 * math.cos(math.radians(lat))
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        a += (x1 * mlon) * (y2 * mlat) - (x2 * mlon) * (y1 * mlat)
    return abs(a) / 2.0


def _round_geom(geom):
    def rr(ring):
        return [[round(x, 6), round(y, 6)] for x, y in ring]
    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": [rr(r) for r in geom["coordinates"]]}
    return {"type": "MultiPolygon",
            "coordinates": [[rr(r) for r in poly] for poly in geom["coordinates"]]}


# ── Crowd density (building density per cell -> ppl/cell) ───────────────
def build_crowd():
    src = VECTOR / "google_open_buildings_guna.geojson"
    if not src.exists():
        return _write("crowd_density_guna.geojson", _fc([]))
    data = json.loads(src.read_text(encoding="utf-8"))
    counts = [[0] * NX for _ in range(NY)]
    dx = (EAST - WEST) / NX
    dy = (NORTH - SOUTH) / NY
    for f in data.get("features", []):
        geom = f.get("geometry")
        if not geom:
            continue
        try:
            ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
        except Exception:
            continue
        if not (WEST <= cx < EAST and SOUTH < cy <= NORTH):
            continue
        c = int((cx - WEST) / dx)
        r = int((NORTH - cy) / dy)
        if 0 <= r < NY and 0 <= c < NX:
            counts[r][c] += 1
    feats = []
    for r in range(NY):
        for c in range(NX):
            n = counts[r][c]
            if n <= 0:
                continue
            lon = WEST + (c + 0.5) * dx
            lat = NORTH - (r + 0.5) * dy
            feats.append({"type": "Feature",
                          "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                          "properties": {"density": int(n * 5)}})   # ~5 people per building
    return _write("crowd_density_guna.geojson", _fc(feats))


def main():
    from config import fix_proj
    fix_proj()
    results = {
        "lulc": build_lulc(),
        "ndvi": build_ndvi(),
        "changes": build_changes(),
        "flood_extent": build_flood(),
        "buildings_ai": build_buildings(),
        "crowd_density": build_crowd(),
    }
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
