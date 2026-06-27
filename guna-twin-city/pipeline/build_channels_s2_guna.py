"""Survey-grade water channels for Guna from Sentinel-2 (10 m) via GEE.

Terrain-derived drainage (MERIT, 90 m) gives connectivity but not survey-grade
channel position — its lines drift up to ~one cell off the true channel and clip
buildings. This instead maps where water *actually is*, from satellite imagery:

  * Sentinel-2 SR Harmonized (10 m), 2019-2024
  * Cloud Score+ per-pixel cloud masking (cs >= 0.6)
  * MNDWI = (B3 green - B11 SWIR)/(B3 + B11)  — water > 0, suppresses built-up
  * multi-year OCCURRENCE = clear obs with water / clear obs  (rejects shadows,
    captures the seasonal channel) — JRC's method at 10 m instead of 30 m

Occurrence is vectorised to the real channel footprint (the Guniya + tanks +
major drains), positioned to the imagery, two tiers:
  occurrence >= 25 %      -> "permanent"  (tanks, perennial pools, river core)
  6 % <= occurrence < 25  -> "seasonal"   (monsoon channel, river margins)

Output (committed):  data/vectors/channels_s2_guna.geojson

Run:  python guna-twin-city/pipeline/build_channels_s2_guna.py
"""
from __future__ import annotations

import io
import json
import math
import os
import zipfile
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.features import shapes
from shapely.geometry import shape, mapping

GUNA = Path(__file__).resolve().parents[1]
OUT = GUNA / "data" / "vectors" / "channels_s2_guna.geojson"
BBOX = (77.235, 24.555, 77.395, 24.715)    # w, s, e, n — scene extent + margin
C = (24.6354, 77.3126)
MLAT = 110540.0
MLNG = 111320.0 * math.cos(math.radians(C[0]))
KEEP_RADIUS_M = 6500.0
MIN_VALID_OBS = 10                          # need enough clear looks to trust a pixel
PERM_T, SEAS_T = 25.0, 6.0                  # occurrence % thresholds
SIMPLIFY_DEG = 0.00010                      # ~11 m — light smoothing of the 10 m staircase
MIN_AREA_DEG2 = (0.00012) ** 2             # drop sub-pixel speckle
NTILE = 3                                   # split into NTILE×NTILE tiles to stay under
TILE_PAD = 0.005                            # GEE's per-request compute budget (deg overlap)
MONTHS = (8, 12)                            # Aug–Dec: post-monsoon, channels hold water


def _init_ee():
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
    else:
        ee.Initialize(project=project)
    return ee


def _occurrence_image(ee):
    region = ee.Geometry.Rectangle(list(BBOX), "EPSG:4326", False)
    s2 = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
          .filterBounds(region).filterDate("2019-01-01", "2025-01-01")
          .filter(ee.Filter.calendarRange(MONTHS[0], MONTHS[1], "month")))
    csp = ee.ImageCollection("GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED")
    s2 = s2.linkCollection(csp, ["cs"])

    def water_bands(img):
        clear = img.select("cs").gte(0.6)
        mndwi = img.normalizedDifference(["B3", "B11"])
        water = mndwi.gt(0.0).And(clear).rename("water")
        return water.addBands(clear.rename("valid"))

    coll = s2.map(water_bands)
    water_cnt = coll.select("water").sum()
    valid_cnt = coll.select("valid").sum()
    occ = (water_cnt.divide(valid_cnt.max(1)).multiply(100)
           .updateMask(valid_cnt.gte(MIN_VALID_OBS))
           .round().toByte().rename("occ"))
    return occ


def _tiles():
    w, s, e, n = BBOX
    dx, dy = (e - w) / NTILE, (n - s) / NTILE
    for j in range(NTILE):
        for i in range(NTILE):
            core = (w + i * dx, s + j * dy, w + (i + 1) * dx, s + (j + 1) * dy)
            fetch = (core[0] - TILE_PAD, core[1] - TILE_PAD,
                     core[2] + TILE_PAD, core[3] + TILE_PAD)
            yield core, fetch


def _fetch_tile(ee, occ, fetch_bbox):
    region = ee.Geometry.Rectangle(list(fetch_bbox), "EPSG:4326", False)
    last = None
    for attempt in range(2):
        try:
            url = occ.clip(region).getDownloadURL({
                "region": region, "scale": 10, "crs": "EPSG:4326",
                "format": "GEO_TIFF", "maxPixels": 1e9,
            })
            blob = requests.get(url, timeout=240).content
            if blob[:2] == b"PK":
                with zipfile.ZipFile(io.BytesIO(blob)) as zf:
                    blob = zf.read(next(n for n in zf.namelist() if n.lower().endswith(".tif")))
            return blob
        except Exception as exc:                # noqa: BLE001 — retry on timeout/5xx
            last = exc
    raise RuntimeError(f"tile {fetch_bbox} failed: {last}")


def _dist_m(lng, lat):
    return math.hypot((lng - C[1]) * MLNG, (lat - C[0]) * MLAT)


def _in_core(lng, lat, core):
    return core[0] <= lng < core[2] and core[1] <= lat < core[3]


def _vectorize(mask, transform, tier, core):
    feats = []
    for geom, val in shapes(mask.astype("uint8"), mask=mask, transform=transform):
        if val != 1:
            continue
        poly = shape(geom)
        if poly.is_empty or poly.area < MIN_AREA_DEG2:
            continue
        c = poly.representative_point()
        if not _in_core(c.x, c.y, core):        # dedup the tile overlap
            continue
        if _dist_m(c.x, c.y) > KEEP_RADIUS_M:
            continue
        poly = poly.simplify(SIMPLIFY_DEG, preserve_topology=True)
        if not poly.is_empty:
            feats.append({"type": "Feature", "geometry": mapping(poly),
                          "properties": {"tier": tier}})
    return feats


def main():
    ee = _init_ee()
    occ_img = _occurrence_image(ee)
    rdir = GUNA / "data" / "rasters"
    rdir.mkdir(parents=True, exist_ok=True)

    feats, max_occ = [], 0
    tiles = list(_tiles())
    for idx, (core, fetch) in enumerate(tiles, 1):
        blob = _fetch_tile(ee, occ_img, fetch)
        tmp = rdir / f"s2_occ_tile_{idx}.tif"
        tmp.write_bytes(blob)
        with rasterio.open(tmp) as s:
            occ = s.read(1)
            tr = s.transform
        max_occ = max(max_occ, int(occ.max()))
        feats += _vectorize(occ >= PERM_T, tr, "permanent", core)
        feats += _vectorize((occ >= SEAS_T) & (occ < PERM_T), tr, "seasonal", core)
        print(f"  tile {idx}/{len(tiles)} done — running total {len(feats)} polys")

    if not feats:
        raise SystemExit("no S2 water vectorized — relax thresholds / widen dates")
    perm = sum(1 for f in feats if f["properties"]["tier"] == "permanent")
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")), encoding="utf-8")
    print(f"S2 water max occurrence {max_occ}%")
    print(f"wrote {OUT.name}: {perm} permanent + {len(feats) - perm} seasonal = "
          f"{len(feats)} channel polys, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
