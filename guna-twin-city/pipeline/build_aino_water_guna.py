"""Extract Guna's real surface water (the Guniya river, streams, tanks) for the
Aino 3D scene from the JRC Global Surface Water raster.

OpenStreetMap has almost no waterways mapped around Guna town (the Guniya river
isn't in OSM), but JRC GSW is satellite-observed water occurrence (0-100 %), so
it captures the actual river + seasonal streams + tanks. We threshold + vectorise
it into a committed GeoJSON the scene renders as blue water.

Two occurrence tiers so the renderer can style permanent vs seasonal water:
  occurrence >= 45  -> "permanent"  (river core, lakes/tanks)
  20 <= occurrence < 45 -> "seasonal" (monsoon streams, river margins)

Output (committed):  data/vectors/jrc_water_guna.geojson

Run:  python guna-twin-city/pipeline/build_aino_water_guna.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import shapes
from shapely.geometry import shape, mapping

GUNA = Path(__file__).resolve().parents[1]
SRC = GUNA / "data" / "rasters" / "jrc_surface_water_guna.tif"
OUT = GUNA / "data" / "vectors" / "jrc_water_guna.geojson"

C = (24.6354, 77.3126)                     # scene centre (lat, lng)
MLAT = 110540.0
MLNG = 111320.0 * math.cos(math.radians(C[0]))
KEEP_RADIUS_M = 6000.0                      # only water within the scene extent
SIMPLIFY_DEG = 0.00035                      # ~35 m — smooth the pixel staircase
MIN_AREA_DEG2 = (0.00025) ** 2             # drop single-pixel speckle


def _dist_m(lng, lat):
    return math.hypot((lng - C[1]) * MLNG, (lat - C[0]) * MLAT)


def _vectorize(mask, transform, tier):
    feats = []
    for geom, val in shapes(mask.astype("uint8"), mask=mask, transform=transform):
        if val != 1:
            continue
        poly = shape(geom)
        if poly.is_empty or poly.area < MIN_AREA_DEG2:
            continue
        c = poly.representative_point()
        if _dist_m(c.x, c.y) > KEEP_RADIUS_M:
            continue
        poly = poly.simplify(SIMPLIFY_DEG, preserve_topology=True)
        if poly.is_empty:
            continue
        feats.append({"type": "Feature", "geometry": mapping(poly),
                      "properties": {"tier": tier}})
    return feats


def main():
    with rasterio.open(SRC) as s:
        occ = s.read(1)
        tr = s.transform
    perm = _vectorize(occ >= 45, tr, "permanent")
    seas = _vectorize((occ >= 20) & (occ < 45), tr, "seasonal")
    feats = perm + seas
    if not feats:
        raise SystemExit("no JRC water vectorized within range")
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.name}: {len(perm)} permanent + {len(seas)} seasonal = "
          f"{len(feats)} water polys, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
