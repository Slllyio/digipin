"""Clip a global SSP urban-land projection to a small per-cell COG.

Produces the forward-looking layer the model reads as `future_expansion`:

    data/growth/ssp_urban_expansion_<region>.tif   (single band, urban fraction 0..1)

Source: global SSP urban-land expansion projections (Chen/Gao/O'Neill; 1 km, to
2050/2100, by socioeconomic scenario). The canonical host is
geosimulation.cn/GlobalSSPsUrbanProduct.html; mirrors exist on figshare/PANGAEA.
Pass the chosen scenario/year GeoTIFF via `--url` (or a local file via `--in`);
the global raster is windowed to the region so only the local area is read.

`realtime-growth.js` reads the COG, `GrowthScore.futureExpansionAdjust` nudges
the 5-yr horizon by it, and `RealEstateModel` exposes a `futureExpansion` factor.

Usage:
    python -m pipeline.growth.download_ssp_urban --url <ssp_scenario_year.tif>
    python -m pipeline.growth.download_ssp_urban --in local_ssp.tif --res 1000
"""
from __future__ import annotations

import argparse
import logging
import tempfile
import urllib.request
from pathlib import Path

from pipeline._lib.regions import get_default_bbox, get_default_region_name

log = logging.getLogger("pipeline.growth.ssp")


def target_dims(bbox, res_m):
    """(width, height) of the output grid for a (w,s,e,n) bbox at res_m metres."""
    w, s, e, n = bbox
    deg = res_m / 111_000.0
    return max(1, round((e - w) / deg)), max(1, round((n - s) / deg))


def clip_resample(src_path, bbox, res_m, out_path):
    """Window `src_path` to bbox, resample to the target grid, write a 0..1 COG.

    Returns the output Path. Pure w.r.t. the filesystem (no network)."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import reproject, Resampling

    w, s, e, n = bbox
    width, height = target_dims(bbox, res_m)
    dst_transform = from_bounds(w, s, e, n, width, height)
    dst = np.zeros((height, width), dtype="float32")

    with rasterio.open(src_path) as src:
        src_crs = src.crs or "EPSG:4326"
        reproject(
            source=rasterio.band(src, 1), destination=dst,
            src_crs=src_crs, dst_crs="EPSG:4326",
            dst_transform=dst_transform, resampling=Resampling.average,
        )
    # Normalise to a 0..1 fraction: many SSP products are already 0..1; some are
    # 0..100 (percent). Detect and scale.
    finite = dst[np.isfinite(dst)]
    if finite.size and finite.max() > 1.5:
        dst = dst / 100.0
    dst = np.clip(np.nan_to_num(dst, nan=0.0), 0.0, 1.0).astype("float32")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path, "w", driver="GTiff", height=height, width=width, count=1,
        dtype="float32", crs="EPSG:4326", transform=dst_transform,
        compress="deflate", tiled=True, blockxsize=256, blockysize=256,
    ) as d:
        d.write(dst, 1)
        d.set_band_description(1, "ssp_urban_fraction")
    return out_path


def main():
    """CLI: clip and resample the SSP urban-expansion raster to the region grid."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="global SSP urban-land GeoTIFF URL")
    src.add_argument("--in", dest="inp", help="local SSP GeoTIFF path")
    ap.add_argument("--res", type=int, default=1000, help="output resolution m (default 1000)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    bbox = get_default_bbox()
    region = get_default_region_name()

    if args.url:
        tmp = Path(tempfile.gettempdir()) / "ssp_src.tif"
        log.info("downloading %s", args.url)
        urllib.request.urlretrieve(args.url, tmp)   # noqa: S310 — operator-supplied URL
        src_path = tmp
    else:
        src_path = Path(args.inp)

    out = Path(args.out) if args.out else Path(f"data/growth/ssp_urban_expansion_{region}.tif")
    clip_resample(src_path, bbox, args.res, out)
    log.info("wrote %s (%.1f KB)", out, out.stat().st_size / 1024)


if __name__ == "__main__":
    main()
