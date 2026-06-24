"""Build the Growth-Forecast building-change COG **without Earth Engine**.

Downloads Google's Open Buildings 2.5D Temporal GeoTIFFs directly from the
public GCS bucket `open-buildings-temporal-data` and assembles the 8-band COG
that `js/realtime-growth.js` already reads:

    data/growth/buildings_temporal_2016-2023_<region>.tif
    band b (0..7) = year 2016+b, value = building_presence (0..1)

Why this exists: the original `extract_buildings_temporal.py` needs Earth Engine
credentials, so the COG was never produced and the Growth Forecast is null in
prod. This path is credentials-free.

Why it downsamples: the native tiles are 0.5 m (25000x25000 px); a full-res
Indore COG would be multiple GB — impossible to fetch in the browser. We
resample to a coarse grid (default 100 m) so the committed COG is ~1-2 MB, which
is all a neighbourhood-scale growth signal needs.

Access chain (verified against the live bucket):
  bbox → S2 level-2 covering tokens → per-year manifests
  `v1/manifests/{token}_EPSG_{epsg}_{year}_06_30.json` → tileset sources
  (uri, affineTransform, dimensions) → keep tiles intersecting the bbox →
  read the `building_presence` band (3rd) → reproject/average onto the target
  WGS84 grid → stack 8 years.

Usage:
    python -m pipeline.growth.download_temporal_gcs --probe        # list tiles, no download
    python -m pipeline.growth.download_temporal_gcs --res 100      # build the COG
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import urllib.request
from pathlib import Path

from pipeline._lib.regions import get_default_bbox, get_default_region_name

log = logging.getLogger("pipeline.growth.temporal_gcs")

BUCKET = "open-buildings-temporal-data"
GCS_JSON = f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o"
GCS_OBJ = f"https://storage.googleapis.com/{BUCKET}"
YEARS = list(range(2016, 2024))            # 8 inclusive years → 8 bands
PRESENCE_BAND = 3                          # 1-indexed: count=1, height=2, presence=3
MISSING = -99.0


# ---------------------------------------------------------------- S2 covering
def s2_tokens(bbox):
    """S2 level-2 cell tokens covering a (west, south, east, north) bbox."""
    import s2sphere as s2
    w, s, e, n = bbox
    rect = s2.LatLngRect(s2.LatLng.from_degrees(s, w), s2.LatLng.from_degrees(n, e))
    cov = s2.RegionCoverer()
    cov.min_level = cov.max_level = 2
    cov.max_cells = 16
    return [c.to_token() for c in cov.get_covering(rect)]


def _get_json(url, timeout=60):
    """Fetch and parse a JSON document over HTTPS (rejects non-HTTPS URLs)."""
    if not url.startswith("https://"):     # defense-in-depth: no file://, ftp://, etc.
        raise ValueError(f"refusing non-HTTPS URL: {url}")
    with urllib.request.urlopen(url, timeout=timeout) as r:   # noqa: S310 (scheme checked)
        return json.load(r)


def list_year_manifests(token, year):
    """Manifest object names for one S2 token + year (one per UTM zone)."""
    out, page = [], None
    while True:
        url = f"{GCS_JSON}?prefix=v1/manifests/{token}_EPSG&maxResults=200"
        if page:
            url += f"&pageToken={page}"
        d = _get_json(url)
        for it in d.get("items", []):
            if f"_{year}_" in it["name"]:
                out.append(it["name"])
        page = d.get("nextPageToken")
        if not page:
            return out


def _epsg_from_name(name):
    """Parse the EPSG code out of a GCS manifest object name."""
    # v1/manifests/3b_EPSG_32643_2020_06_30.json → 32643
    return int(name.split("_EPSG_")[1].split("_")[0])


def tile_wgs84_bounds(source, epsg):
    """(west, south, east, north) of a manifest source tile, in WGS84."""
    from rasterio.warp import transform_bounds
    a = source["affineTransform"]
    dim = source["dimensions"]
    minx = a["translateX"]
    maxx = a["translateX"] + a["scaleX"] * dim["width"]
    maxy = a["translateY"]
    miny = a["translateY"] + a["scaleY"] * dim["height"]   # scaleY < 0
    return transform_bounds(f"EPSG:{epsg}", "EPSG:4326",
                            min(minx, maxx), min(miny, maxy), max(minx, maxx), max(miny, maxy))


def _intersects(a, b):
    """True if two (west, south, east, north) bounding boxes overlap."""
    return not (a[2] <= b[0] or a[0] >= b[2] or a[3] <= b[1] or a[1] >= b[3])


def select_tiles(bbox, year):
    """List of (epsg, https_url, wgs84_bounds) for tiles intersecting bbox in `year`."""
    tiles = []
    seen_tokens = s2_tokens(bbox)
    for token in seen_tokens:
        for man_name in list_year_manifests(token, year):
            epsg = _epsg_from_name(man_name)
            man = _get_json(f"{GCS_OBJ}/{man_name}")
            prefix = man["uriPrefix"].replace(f"gs://{BUCKET}/", "")
            for ts in man.get("tilesets", []):
                for src in ts.get("sources", []):
                    b = tile_wgs84_bounds(src, epsg)
                    if _intersects(b, bbox):
                        uri = src["uris"][0]
                        tiles.append((epsg, f"{GCS_OBJ}/{prefix}/{uri}", b))
    return tiles


# ---------------------------------------------------------------- build COG
def build_cog(bbox, res_m, out_path):
    """Mosaic and reproject intersecting tiles into a clipped cloud-optimized GeoTIFF."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import reproject, Resampling

    w, s, e, n = bbox
    # target WGS84 grid at ~res_m metres (deg/m varies; ~111 km per degree lat)
    deg = res_m / 111_000.0
    width = max(1, round((e - w) / deg))
    height = max(1, round((n - s) / deg))
    dst_transform = from_bounds(w, s, e, n, width, height)
    log.info("target grid %dx%d @ ~%dm", width, height, res_m)

    bands = []
    for year in YEARS:
        acc = np.zeros((height, width), dtype="float32")
        cnt = np.zeros((height, width), dtype="float32")
        tiles = select_tiles(bbox, year)
        log.info("%d: %d intersecting tiles", year, len(tiles))
        for _epsg, url, _b in tiles:
            with rasterio.open(f"/vsicurl/{url}") as src:
                dst = np.full((height, width), MISSING, dtype="float32")
                reproject(
                    source=rasterio.band(src, PRESENCE_BAND),
                    destination=dst,
                    dst_transform=dst_transform, dst_crs="EPSG:4326",
                    src_nodata=MISSING, dst_nodata=MISSING,
                    resampling=Resampling.average,
                )
                valid = dst != MISSING
                acc[valid] += np.clip(dst[valid], 0, 1)
                cnt[valid] += 1
        band = np.where(cnt > 0, acc / np.maximum(cnt, 1), 0.0).astype("float32")
        bands.append(band)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path, "w", driver="GTiff", height=height, width=width, count=len(YEARS),
        dtype="float32", crs="EPSG:4326", transform=dst_transform,
        compress="deflate", tiled=True, blockxsize=256, blockysize=256,
    ) as dst:
        for i, band in enumerate(bands):
            dst.write(band, i + 1)
            dst.set_band_description(i + 1, str(YEARS[i]))
    log.info("wrote %s (%.2f MB)", out_path, out_path.stat().st_size / 1e6)


def main():
    """CLI: build a multi-year temporal COG for the region from GCS tiles."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", type=int, default=100, help="output resolution in metres (default 100)")
    ap.add_argument("--probe", action="store_true", help="list intersecting tiles per year, no download")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    bbox = get_default_bbox()
    region = get_default_region_name()
    log.info("region %s bbox %s · S2 tokens %s", region, bbox, s2_tokens(bbox))

    if args.probe:
        total = 0
        for year in YEARS:
            tiles = select_tiles(bbox, year)
            total += len(tiles)
            log.info("  %d → %d tiles (e.g. %s)", year, len(tiles),
                     tiles[0][1].split("/")[-1] if tiles else "—")
        log.info("TOTAL %d tile-fetches across %d years; output res %dm", total, len(YEARS), args.res)
        return

    out = Path(args.out) if args.out else Path(
        f"data/growth/buildings_temporal_2016-2023_{region}.tif")
    build_cog(bbox, args.res, out)


if __name__ == "__main__":
    sys.exit(main())
