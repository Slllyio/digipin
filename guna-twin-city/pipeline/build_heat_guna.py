"""Fetch MODIS LST (Urban Heat Island) for Guna as the 18-band COG the
frontend's RealtimeHeat module reads.

The repo's pipeline/heat/extract_modis_lst.py builds the canonical image but
exports the *national* India raster to Google Drive (async batch). Guna is a
single ~15 km city, so we reuse the identical band recipe (MODIS/061/MOD11A1,
day+night annual means 2016-2024) but pull it synchronously via getDownloadURL
straight to disk — no Drive round-trip.

Output band order matches js/realtime-heat.js exactly:
    band 0 = lst_day_2016, band 1 = lst_night_2016, ... band 17 = lst_night_2024
Each band is Kelvin x 50 (MODIS native scaling); 0 = no-data sentinel.

Run:  python guna-twin-city/pipeline/build_heat_guna.py
"""
from __future__ import annotations

import io
import logging
import os
import zipfile
from pathlib import Path

log = logging.getLogger("guna.heat")

# Guna metro bbox (west, south, east, north) — matches pipeline/_lib/regions.py.
GUNA_BBOX = (77.25, 24.58, 77.40, 24.70)
# RealtimeHeat samples an ~0.09° (~10 km) ring around each cell for the rural UHI
# baseline, so the raster must extend past the metro by at least that much or the
# ring falls off-raster and the anomaly comes back null. 0.12° buffer is safe.
RING_BUFFER_DEG = 0.12
YEARS = list(range(2016, 2025))            # 9 years -> 18 bands (day+night)
ASSET_ID = "MODIS/061/MOD11A1"
SCALE_M = 1000
OUT = Path(__file__).resolve().parent.parent / "data" / "heat" / "modis_lst_2016-2024.tif"


def _buffered_bbox():
    w, s, e, n = GUNA_BBOX
    b = RING_BUFFER_DEG
    return (w - b, s - b, e + b, n + b)


def _clean_geotiff(path):
    """Rewrite a GEE getDownloadURL tif as a clean float32 GeoTIFF.

    GEE direct downloads set the TIFF ExtraSamples/Photometric tags in a way the
    browser's geotiff.js misparses (the parsed georaster ends up without working
    geo accessors). A rasterio round-trip normalises the tags. float32 also matches
    the canonical toDrive COG the frontend was built against."""
    import rasterio
    with rasterio.open(path) as s:
        data = s.read().astype("float32")
        profile = s.profile.copy()
        descs = s.descriptions
    profile.update(driver="GTiff", dtype="float32", tiled=True, blockxsize=256,
                   blockysize=256, compress="deflate")
    profile.pop("photometric", None)
    with rasterio.open(path, "w", **profile) as d:
        d.write(data)
        for i, desc in enumerate(descs, start=1):
            if desc:
                d.set_band_description(i, desc)


def _init_ee():
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
    else:
        ee.Initialize(project=project)
    return ee


def _build_image(ee):
    """18-band image: lst_day_<y> + lst_night_<y> per year, Kelvin x 50, 0=nodata."""
    coll = ee.ImageCollection(ASSET_ID)
    bands = []
    for year in YEARS:
        annual = coll.filterDate(f"{year}-01-01", f"{year}-12-31")
        day = annual.select("LST_Day_1km").mean().rename(f"lst_day_{year}")
        night = annual.select("LST_Night_1km").mean().rename(f"lst_night_{year}")
        bands.extend([day, night])
    # Round to the documented uint16 Kelvin x 50 encoding; unmask 0 = no-data.
    return ee.Image.cat(bands).round().toUint16().unmask(0)


def _download_geotiff(ee, image, region):
    """Synchronous direct download; returns the GeoTIFF bytes (handles zip-wrapped)."""
    import requests

    url = image.getDownloadURL({
        "region": region,
        "scale": SCALE_M,
        "crs": "EPSG:4326",
        "format": "GEO_TIFF",
        "maxPixels": 1e9,
    })
    log.info("Fetching %s", url)
    resp = requests.get(url, timeout=180)
    resp.raise_for_status()
    blob = resp.content
    # GEO_TIFF can come back raw or zip-wrapped depending on band count.
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            tif_name = next(n for n in zf.namelist() if n.lower().endswith(".tif"))
            blob = zf.read(tif_name)
    return blob


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    ee = _init_ee()
    region = ee.Geometry.Rectangle(list(_buffered_bbox()), "EPSG:4326", False)
    image = _build_image(ee)
    blob = _download_geotiff(ee, image, region)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(blob)
    _clean_geotiff(OUT)
    log.info("Wrote %s (%d KB, buffered for UHI ring)", OUT, OUT.stat().st_size // 1024)


if __name__ == "__main__":
    main()
