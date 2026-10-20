"""Sample population + elevation per DIGIPIN cell from local rasters (A3).

Produces the ``environment`` sub-dict that composite.compute_scores reads —
``populationDensity.personsPerHectare`` and ``elevation`` (center / relative /
isLowLying). Parity by construction: the elevation math mirrors
fetchElevation (js/data-fetcher.js:1123-1147) exactly (5-point sample at
±0.0018 deg, relative = center - mean(4), isLowLying = center < avg - 2); only
the raster source differs (GHSL pop COG, Copernicus GLO-30 DEM).

A GHSL GHS-POP pixel is persons per 100 m cell, and a 100 m pixel is one
hectare, so personsPerHectare = pixel value with no conversion (mirrors
js/data-fetcher.js:1198 round()).
"""
from __future__ import annotations

from typing import Callable, Optional

import numpy as np
import rasterio
from rasterio.windows import from_bounds

_ELEV_OFFSET = 0.0018  # ~200 m, matching fetchElevation


def _pop_per_hectare(ds, bounds: dict) -> Optional[int]:
    """Mean of GHSL pixels intersecting the cell rect (nodata-masked), rounded."""
    try:
        win = from_bounds(bounds["west"], bounds["south"], bounds["east"], bounds["north"], ds.transform)
        arr = ds.read(1, window=win, boundless=True,
                      fill_value=ds.nodata if ds.nodata is not None else 0)
    except Exception:
        return None
    a = np.asarray(arr, dtype="float64").ravel()
    if ds.nodata is not None:
        a = a[a != ds.nodata]
    a = a[np.isfinite(a) & (a >= 0)]
    if a.size == 0:
        # window fell between pixel centres — fall back to the centre point
        cx = (bounds["west"] + bounds["east"]) / 2
        cy = (bounds["south"] + bounds["north"]) / 2
        v = next(iter(ds.sample([(cx, cy)])))[0]
        if ds.nodata is not None and v == ds.nodata:
            return None
        return round(float(v)) if v >= 0 else None
    return round(float(a.mean()))


def _elevation(ds, lat: float, lng: float) -> Optional[dict]:
    off = _ELEV_OFFSET
    pts = [(lng, lat), (lng, lat + off), (lng, lat - off), (lng + off, lat), (lng - off, lat)]
    raw = [float(v[0]) for v in ds.sample(pts)]
    nd = ds.nodata

    def ok(v):
        return nd is None or v != nd

    if not ok(raw[0]):
        return None
    center = raw[0]
    surrounding = [v for v in raw[1:] if ok(v)]
    if not surrounding:
        return None
    avg = sum(surrounding) / len(surrounding)
    return {
        "center": center,
        "surrounding": avg,
        "relative": center - avg,
        "isLowLying": center < avg - 2,
    }


def make_env_sampler(
    pop_tif: Optional[str] = None,
    dem_tif: Optional[str] = None,
) -> Callable[[dict], dict]:
    """Return a sampler: cell -> environment dict. Missing rasters -> omitted keys.

    Datasets are opened once and reused across cells (sequential, single process).
    """
    pop_ds = rasterio.open(pop_tif) if pop_tif else None
    dem_ds = rasterio.open(dem_tif) if dem_tif else None

    def sampler(cell: dict) -> dict:
        env: dict = {}
        if pop_ds is not None:
            pph = _pop_per_hectare(pop_ds, cell["bounds"])
            if pph is not None:
                env["populationDensity"] = {"personsPerHectare": pph, "source": "GHSL"}
        if dem_ds is not None:
            elev = _elevation(dem_ds, cell["center"]["lat"], cell["center"]["lng"])
            if elev is not None:
                env["elevation"] = elev
        return env

    return sampler
