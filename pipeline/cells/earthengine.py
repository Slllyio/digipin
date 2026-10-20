"""Earth Engine → DIGIPIN cells: fetch any ee.Image as one value per cell.

The output grid is aligned to DIGIPIN cell edges at the requested level, so
each output pixel *is* one cell and no re-binning is needed. Each band is
first reprojected to its source's working scale, then ``reduceResolution``
averages (or takes the mode of) every source pixel inside the cell, so a
244 m cell over a 10 m raster is the mean of ~600 pixels, not one sample.

Auth follows scripts/build_building_heights.py: ``GEE_SERVICE_ACCOUNT_KEY``
(key JSON) when set, otherwise the Claude cloud egress proxy injects the
bearer token for earthengine.googleapis.com. ``GEE_PROJECT`` picks the
billing project (default ``van-suraksha-alert``).

Requires earthengine-api and numpy.
"""
from __future__ import annotations

import io
import json
import math
import os
import tempfile
from typing import Optional

from pipeline._lib import digipin

NODATA = -9999.0
_ee = None


def init():
    """Initialise Earth Engine once and return the ``ee`` module."""
    global _ee
    if _ee is not None:
        return _ee
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    key = os.environ.get("GEE_SERVICE_ACCOUNT_KEY")
    if not key:
        # Placeholder token; the egress proxy overwrites it with the real one.
        from google.oauth2.credentials import Credentials
        ee.Initialize(Credentials(token="proxy-injected"), project=project)
    else:
        info = json.loads(key)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(info, fh)
            key_path = fh.name
        try:
            ee.Initialize(ee.ServiceAccountCredentials(info["client_email"], key_path),
                          project=project)
        finally:
            try:
                os.unlink(key_path)
            except OSError:
                pass
    _ee = ee
    return ee


def cell_step(level: int) -> tuple[float, float]:
    """(lat_step, lon_step) in degrees of a DIGIPIN cell at ``level``."""
    b = digipin.BOUNDS
    return (b["maxLat"] - b["minLat"]) / 4 ** level, (b["maxLon"] - b["minLon"]) / 4 ** level


def aligned_bbox(bbox, level: int) -> tuple[float, float, float, float]:
    """Expand (w, s, e, n) outward to DIGIPIN cell edges at ``level``."""
    lat_step, lon_step = cell_step(level)
    b = digipin.BOUNDS
    w = b["minLon"] + math.floor((bbox[0] - b["minLon"]) / lon_step) * lon_step
    s = b["minLat"] + math.floor((bbox[1] - b["minLat"]) / lat_step) * lat_step
    e = b["minLon"] + math.ceil((bbox[2] - b["minLon"]) / lon_step) * lon_step
    n = b["minLat"] + math.ceil((bbox[3] - b["minLat"]) / lat_step) * lat_step
    return w, s, e, n


def to_cells(img, scale_m: float, reducer: str = "mean"):
    """Prepare ``img`` for a cell-grid fetch: work at ``scale_m``, aggregate
    every working pixel inside each output cell with ``reducer``
    ("mean" | "mode" | "min" | "max"), and mark empty cells as NODATA."""
    ee = init()
    red = {"mean": ee.Reducer.mean(), "mode": ee.Reducer.mode(),
           "min": ee.Reducer.min(), "max": ee.Reducer.max()}[reducer]
    names = img.bandNames()
    out = (img.reproject(ee.Projection("EPSG:4326").atScale(scale_m))
              .reduceResolution(red, maxPixels=65535))
    # Reducers suffix band names ("x_mean"); restore the originals.
    return out.rename(names).unmask(NODATA)


def fetch(img, bbox, level: int, tile: int = 256) -> dict:
    """{code: {band: value | None}} for every cell of ``bbox`` at ``level``.

    ``img`` is an image already passed through :func:`to_cells`.
    """
    import numpy as np
    ee = init()
    w, s, e, n = aligned_bbox(bbox, level)
    lat_step, lon_step = cell_step(level)
    cols, rows = round((e - w) / lon_step), round((n - s) / lat_step)
    out: dict = {}
    for r0 in range(0, rows, tile):
        for c0 in range(0, cols, tile):
            h, wd = min(tile, rows - r0), min(tile, cols - c0)
            raw = _retry(lambda: ee.data.computePixels({
                "expression": img,
                "fileFormat": "NPY",
                "grid": {
                    "dimensions": {"width": wd, "height": h},
                    "affineTransform": {
                        "scaleX": lon_step, "shearX": 0, "translateX": w + c0 * lon_step,
                        "shearY": 0, "scaleY": -lat_step, "translateY": n - r0 * lat_step,
                    },
                    "crsCode": "EPSG:4326",
                },
            }))
            arr = np.load(io.BytesIO(raw))
            names = arr.dtype.names
            for r in range(h):
                lat = n - (r0 + r + 0.5) * lat_step
                for c in range(wd):
                    lng = w + (c0 + c + 0.5) * lon_step
                    code = digipin.encode(lat, lng).replace("-", "")[:level]
                    row = out.setdefault(code, {})
                    for k in names:
                        v = float(arr[k][r, c])
                        row[k] = None if (not math.isfinite(v) or v <= NODATA + 1) else v
    return out


def _retry(fn, tries: int = 4):
    import time
    for i in range(tries):
        try:
            return fn()
        except Exception as exc:  # EE raises plain Exception subclasses
            msg = str(exc)
            if i == tries - 1 or not any(t in msg for t in ("429", "503", "500", "timed out",
                                                            "Too many", "deadline", "Connection")):
                raise
            time.sleep(4 * 2 ** i)


def merge(*parts: dict) -> dict:
    """Merge several {code: {band: v}} fetches cell-by-cell."""
    out: dict = {}
    for p in parts:
        for code, row in p.items():
            out.setdefault(code, {}).update(row)
    return out


def cell_area_km2(code: str) -> float:
    """Ground area of a DIGIPIN cell in km² (equirectangular, fine at city scale)."""
    b = digipin.decode_partial(code)["bounds"]
    lat = math.radians((b["south"] + b["north"]) / 2)
    dy = (b["north"] - b["south"]) * 111.32
    dx = (b["east"] - b["west"]) * 111.32 * math.cos(lat)
    return dx * dy


def r(v: Optional[float], nd: int = 1) -> Optional[float]:
    """Round, passing None through."""
    return None if v is None else round(v, nd)
