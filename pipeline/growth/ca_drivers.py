"""Spatial driver layers for the CA-ML urban-growth model (`urban_ca_ml.py`).

Builds a stack of driver rasters aligned to the temporal-COG grid (same shape /
transform / CRS), so each cell's drivers line up with its built-up history:

    slope · distance-to-roads · distance-to-water · distance-to-existing-built ·
    population (GHSL) · night-lights (VIIRS)

Sources are reused from the existing pipeline: Copernicus GLO-30 DEM
(`regions.dem_tile_urls`), OSM road/water vectors (`data/vectors/osm_*.geojson`),
and the GHSL/VIIRS COGs. `slope_from_dem` and `distance_field` are pure
(numpy/scipy) and unit-tested; the mosaic/rasterise/stack orchestration is lazy.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

log = logging.getLogger("pipeline.growth.ca_drivers")


# ───────────────────────── pure helpers ─────────────────────────
def slope_from_dem(elev, res_m=100.0):
    """Slope in degrees from an elevation grid (m) at `res_m` spacing. Pure."""
    elev = np.asarray(elev, dtype="float32")
    dzdy, dzdx = np.gradient(elev, res_m, res_m)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype("float32")


def distance_field(mask, res_m=100.0):
    """Euclidean distance (m) from every cell to the nearest True cell. Pure
    (scipy). All-False input → a large constant field."""
    from scipy import ndimage
    mask = np.asarray(mask, dtype=bool)
    if not mask.any():
        return np.full(mask.shape, 1e6, dtype="float32")
    # distance_transform_edt measures distance to the nearest ZERO, so invert.
    return (ndimage.distance_transform_edt(~mask) * res_m).astype("float32")


def normalize01(arr):
    """Min-max to 0..1 (robust to constant input). Pure."""
    a = np.asarray(arr, dtype="float32")
    lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
    return np.zeros_like(a) if hi <= lo else ((a - lo) / (hi - lo)).astype("float32")


# ───────────────────────── orchestration (raster IO) ─────────────────────────
def _rasterize_geojson(path, ref_profile):
    """Burn a GeoJSON's geometries onto the reference grid → bool mask."""
    import rasterio
    from rasterio.features import rasterize
    if not Path(path).exists():
        return np.zeros((ref_profile["height"], ref_profile["width"]), dtype=bool)
    gj = json.loads(Path(path).read_text())
    shapes = [(f["geometry"], 1) for f in gj.get("features", []) if f.get("geometry")]
    if not shapes:
        return np.zeros((ref_profile["height"], ref_profile["width"]), dtype=bool)
    arr = rasterize(shapes, out_shape=(ref_profile["height"], ref_profile["width"]),
                    transform=ref_profile["transform"], fill=0, default_value=1,
                    all_touched=True, dtype="uint8")
    return arr.astype(bool)


def _read_aligned(path, ref_profile):
    """Read a single-band raster reprojected onto the reference grid, else zeros."""
    import rasterio
    from rasterio.warp import reproject, Resampling
    h, w = ref_profile["height"], ref_profile["width"]
    if not Path(path).exists():
        return np.zeros((h, w), dtype="float32")
    dst = np.zeros((h, w), dtype="float32")
    with rasterio.open(path) as src:
        reproject(source=rasterio.band(src, 1), destination=dst,
                  dst_transform=ref_profile["transform"], dst_crs=ref_profile["crs"],
                  resampling=Resampling.average)
    return dst


def build_stack(region, bbox, ref_profile):
    """Assemble the (H, W, K) driver stack aligned to `ref_profile`.

    Heavy IO (DEM mosaic, OSM rasterise, GHSL/VIIRS) — runs where the source data
    is present; missing inputs degrade to zero layers so the model still trains
    on whatever drivers exist."""
    res_m = 100.0

    # slope from an aligned DEM (data/growth/dem_<region>.tif, mosaicked from the
    # Copernicus GLO-30 tiles in regions.dem_tile_urls); zeros if absent.
    elev = _read_aligned(f"data/growth/dem_{region}.tif", ref_profile)
    slope = slope_from_dem(elev, res_m)

    roads = _rasterize_geojson(f"data/vectors/osm_roads_{region}.geojson", ref_profile)
    water = _rasterize_geojson(f"data/vectors/osm_water_{region}.geojson", ref_profile)

    layers = [
        normalize01(slope),
        normalize01(distance_field(roads, res_m)),
        normalize01(distance_field(water, res_m)),
        normalize01(_read_aligned(f"data/growth/ghsl_pop_2020_{region}.tif", ref_profile)),
    ]
    # night-lights: take the latest VIIRS band if present
    viirs = Path(f"data/growth/viirs_2016-2024_{region}.tif")
    if viirs.exists():
        import rasterio
        with rasterio.open(viirs) as src:
            layers.append(normalize01(src.read(src.count).astype("float32")))
    stack = np.stack([np.asarray(x, dtype="float32") for x in layers], axis=-1)
    log.info("driver stack %s (%d layers)", stack.shape, stack.shape[-1])
    return stack
