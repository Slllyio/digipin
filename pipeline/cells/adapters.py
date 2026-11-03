"""Turn the repo's existing per-area outputs into cell-store records.

Each adapter yields plain record dicts (``{"lat", "lng"} | {"digipin"}`` plus
field values) for ``store.bin_records``, so a new source only needs a reader —
never new rendering code. Three shapes exist in the repo today:

  * score shards    data/scores/<region>/<prefix>.json  {code: [v1..vN]}
  * regular grids   data/{traffic,safety}/<region>/*_grid.json (row-major, row 0 = north)
  * rasters         any single/multi-band GeoTIFF in EPSG:4326 (``raster_records``)
  * points / rows   any CSV or GeoJSON (see ``pipeline.cells.ingest``)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Iterator, Optional

from pipeline._lib import digipin, grid as cell_grid


def score_shard_records(scores_root, region: str) -> tuple[list, Iterator[dict]]:
    """(fields, records) from the precomputed score shards for ``region``.

    Codes are already DIGIPIN cells, so records carry ``digipin`` and the
    binning step is an identity mapping at the shards' level.
    """
    root = Path(scores_root)
    cov = json.loads((root / "coverage.json").read_text())
    reg = next((r for r in cov["regions"] if r["name"] == region), None)
    if reg is None:
        raise ValueError(f"region {region!r} not in {root / 'coverage.json'}")
    fields = cov["fields"]

    def gen():
        for prefix in reg.get("shards", []):
            p = root / region / f"{prefix}.json"
            if not p.exists():
                continue
            for code, values in json.loads(p.read_text()).items():
                rec = {"digipin": code}
                rec.update(zip(fields, values))
                yield rec

    return fields, gen()


def grid_records(grid: dict, keys: list,
                 keep: Optional[Callable[[dict], bool]] = None) -> Iterator[dict]:
    """Records at each pixel centre of a row-major regular grid.

    ``grid`` is the footprint-grid shape used by traffic_grid.json /
    mobility_grid.json: {bounds:{west,south,east,north}, nx, ny, <key>:[...]}.
    ``keep`` filters pixels (e.g. "has a road") so the store stays sparse.
    """
    b, nx, ny = grid["bounds"], int(grid["nx"]), int(grid["ny"])
    dx = (b["east"] - b["west"]) / nx
    dy = (b["north"] - b["south"]) / ny
    arrays = {k: grid.get(k) for k in keys}
    for y in range(ny):
        lat = b["north"] - (y + 0.5) * dy
        for x in range(nx):
            i = y * nx + x
            rec = {k: (a[i] if a is not None and i < len(a) else None) for k, a in arrays.items()}
            if keep is not None and not keep(rec):
                continue
            rec["lat"] = lat
            rec["lng"] = b["west"] + (x + 0.5) * dx
            yield rec


def _finite(v) -> Optional[float]:
    v = float(v)
    return v if v == v and v not in (float("inf"), float("-inf")) else None


def raster_records(path, bands: dict, level: int,
                   derive: Optional[dict] = None,
                   keep: Optional[Callable[[dict], bool]] = None) -> Iterator[dict]:
    """Records sampling a GeoTIFF (EPSG:4326) into DIGIPIN cells at ``level``.

    bands   {key: 1-based band index}: the raw values each record carries.
    derive  {key: fn(record) -> value}: computed after reading, e.g. unit
            conversion or a change between two years. A derived key may
            overwrite a band key.
    keep    filter applied to the finished record (keeps the store sparse).

    Resolution is handled automatically. When pixels are finer than cells, one
    record per pixel centre is emitted, so ``bin_records`` with ``agg="mean"``
    gives the zonal mean (``"sum"`` for counts like population). When pixels
    are coarser, one record per cell centre samples the pixel underneath, so
    every cell gets a value instead of one cell in sixteen.
    Non-finite / nodata pixels become None.
    """
    import rasterio

    with rasterio.open(path) as r:
        arrays = {k: r.read(int(b)) for k, b in bands.items()}
        nodata = r.nodata
        t = r.transform
        h, w = r.height, r.width
        west, south, east, north = r.bounds

    def value(arr, row, col):
        v = _finite(arr[row, col])
        return None if v is None or (nodata is not None and v == nodata) else v

    def finish(rec):
        for k, fn in (derive or {}).items():
            try:
                rec[k] = fn(rec)
            except (TypeError, ValueError, ZeroDivisionError):
                rec[k] = None
        return rec if keep is None or keep(rec) else None

    cell_deg = (digipin.BOUNDS["maxLat"] - digipin.BOUNDS["minLat"]) / 4 ** level
    if abs(t.a) <= cell_deg:
        for row in range(h):
            lat = t.f + (row + 0.5) * t.e
            for col in range(w):
                rec = {k: value(a, row, col) for k, a in arrays.items()}
                rec["lat"], rec["lng"] = lat, t.c + (col + 0.5) * t.a
                rec = finish(rec)
                if rec is not None:
                    yield rec
        return

    bbox = {"west": west, "south": south, "east": east, "north": north}
    for cell in cell_grid.cells_for_bbox(bbox, level):
        lat, lng = cell["center"]["lat"], cell["center"]["lng"]
        col = int((lng - t.c) / t.a)
        row = int((lat - t.f) / t.e)
        if not (0 <= row < h and 0 <= col < w):
            continue
        rec = {k: value(a, row, col) for k, a in arrays.items()}
        rec["digipin"] = cell["code"]
        rec = finish(rec)
        if rec is not None:
            yield rec
