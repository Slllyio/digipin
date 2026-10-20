#!/usr/bin/env python3
"""
Bake a DIGIPIN-keyed building-height grid from Google Open Buildings 2.5D.

Earlier versions keyed heights by Overture building id. Overture ids changed
between the 2024 beta tiles and the current releases (0 of 11.6k central
Indore buildings matched), so an id-keyed lookup silently stops working on
every tile refresh. A height grid keyed by DIGIPIN cell is release-proof:
the web app (js/buildings-deck.js → loadHeights) encodes each building's
centroid to a DIGIPIN and reads the cell's height, whichever Overture
release drew the footprint.

Output (data/heights/<region>_heights_digipin.json):

    { "level": 8, "source": "...", "bbox": [w, s, e, n],
      "cells": { "<8-char DIGIPIN>": <median metres>, ... } }

Level 8 cells are ~60 m square: one value per city block, which matches the
~4 m raster's real precision once averaged over built pixels.

Two modes:

  1. Earth Engine (any region in pipeline/_lib/regions.py; needs a GEE
     service-account key in GEE_SERVICE_ACCOUNT_KEY, or in a Claude cloud
     session a "GCP access token" network secret on earthengine.googleapis.com):

         export GEE_SERVICE_ACCOUNT_KEY="$(cat key.json)"
         export GEE_PROJECT=van-suraksha-alert        # the default
         python3 scripts/build_building_heights.py --region indore_pilot

     Averages the Open Buildings 2.5D Temporal `building_height` band over
     built pixels on a lat/lng grid aligned to DIGIPIN cells, so each output
     pixel is exactly one DIGIPIN cell.

  2. Legacy re-key (no network): converts an old id-keyed file. Overture's
     2024 ids embed an H3 res-11 cell (~25 m) as their first 16 hex chars,
     which locates each building well enough for a level-8 cell.

         python3 scripts/build_building_heights.py --from-legacy old.json

Requires: earthengine-api, numpy (mode 1) or h3 (mode 2).
"""
import argparse
import json
import os
import statistics
import sys
import tempfile
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
from _lib import digipin  # noqa: E402
from _lib.regions import bbox_for  # noqa: E402

EE_COLLECTION = "GOOGLE/Research/open-buildings-temporal/v1"
EE_YEAR = 2023
OUT_DIR = os.path.join(ROOT, "data", "heights")


def cell_size(level):
    """(lat_step, lon_step) in degrees of a DIGIPIN cell at `level`."""
    b = digipin.BOUNDS
    return (b["maxLat"] - b["minLat"]) / 4 ** level, (b["maxLon"] - b["minLon"]) / 4 ** level


def aligned_bbox(bbox, level):
    """Expand (w, s, e, n) outward to DIGIPIN cell edges at `level`."""
    import math
    lat_step, lon_step = cell_size(level)
    b = digipin.BOUNDS
    w = b["minLon"] + math.floor((bbox[0] - b["minLon"]) / lon_step) * lon_step
    s = b["minLat"] + math.floor((bbox[1] - b["minLat"]) / lat_step) * lat_step
    e = b["minLon"] + math.ceil((bbox[2] - b["minLon"]) / lon_step) * lon_step
    n = b["minLat"] + math.ceil((bbox[3] - b["minLat"]) / lat_step) * lat_step
    return w, s, e, n


def ee_init():
    """Initialise Earth Engine from the GEE_SERVICE_ACCOUNT_KEY env var (JSON)."""
    import ee
    # Cloud project that bills the EE requests (the team's project by default).
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    key = os.environ.get("GEE_SERVICE_ACCOUNT_KEY")
    if not key:
        # Claude cloud sessions: a "GCP access token" network secret on
        # earthengine.googleapis.com makes the egress proxy inject the real
        # bearer token, so the key never enters the container. The token here
        # is only a placeholder the proxy overwrites.
        from google.oauth2.credentials import Credentials
        print("  GEE_SERVICE_ACCOUNT_KEY not set; relying on proxy-injected auth")
        ee.Initialize(Credentials(token="proxy-injected"), project=project)
        return ee
    info = json.loads(key)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(info, fh)
        key_path = fh.name
    try:
        creds = ee.ServiceAccountCredentials(info["client_email"], key_path)
        ee.Initialize(creds, project=project)
    finally:
        # Don't leave the service-account key sitting on disk.
        try: os.unlink(key_path)
        except OSError: pass
    return ee


def grid_from_ee(bbox, level):
    """Mean built-pixel height per DIGIPIN cell over bbox, via one GeoTIFF download."""
    import io
    import numpy as np
    ee = ee_init()
    w, s, e, n = aligned_bbox(bbox, level)
    lat_step, lon_step = cell_size(level)
    cols, rows = round((e - w) / lon_step), round((n - s) / lat_step)
    img = (ee.ImageCollection(EE_COLLECTION)
           .filter(ee.Filter.calendarRange(EE_YEAR, EE_YEAR, "year"))
           .select("building_height")
           .mosaic())
    img = img.updateMask(img.gt(0))   # average over built pixels only
    # crsTransform pins each output pixel to one DIGIPIN cell (north-up grid).
    url = img.reduceResolution(ee.Reducer.mean(), maxPixels=65535).getDownloadURL({
        "crs": "EPSG:4326",
        "crsTransform": [lon_step, 0, w, 0, -lat_step, n],
        "dimensions": f"{cols}x{rows}",
        "format": "NPY",
    })
    print(f"  downloading {cols}x{rows} grid…")
    arr = np.load(io.BytesIO(urllib.request.urlopen(url, timeout=600).read()))
    band = arr["building_height"] if arr.dtype.names else arr
    cells = {}
    for r in range(rows):
        lat = n - (r + 0.5) * lat_step
        for c in range(cols):
            v = band[r, c]
            if np.ma.is_masked(v) or not np.isfinite(v) or v <= 0:
                continue
            code = digipin.encode(lat, w + (c + 0.5) * lon_step).replace("-", "")[:level]
            cells[code] = round(float(v), 1)
    return cells, (w, s, e, n)


def grid_from_legacy(path, level):
    """Re-key an Overture-id → metres file into DIGIPIN cell → median metres."""
    import h3
    with open(path) as fh:
        by_id = json.load(fh)
    buckets = {}
    for bid, h in by_id.items():
        if not h or h <= 0:
            continue
        cell = bid[:16].lstrip("0")
        if not h3.is_valid_cell(cell):
            continue
        lat, lng = h3.cell_to_latlng(cell)
        code = digipin.encode(lat, lng).replace("-", "")[:level]
        buckets.setdefault(code, []).append(h)
    cells = {k: round(statistics.median(v), 1) for k, v in buckets.items()}
    lats = [digipin.decode_partial(k)["lat"] for k in cells]
    lngs = [digipin.decode_partial(k)["lng"] for k in cells]
    return cells, (min(lngs), min(lats), max(lngs), max(lats))


def main():
    """Build the grid in the chosen mode and write the JSON lookup."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--region", default="indore_pilot", help="region key from pipeline/_lib/regions.py")
    ap.add_argument("--level", type=int, default=8, help="DIGIPIN level of the grid (8 ≈ 60 m)")
    ap.add_argument("--from-legacy", metavar="JSON", help="re-key an old Overture-id → metres file")
    ap.add_argument("--out", help="output path (default data/heights/<region>_heights_digipin.json)")
    args = ap.parse_args()

    if args.from_legacy:
        cells, bbox = grid_from_legacy(args.from_legacy, args.level)
        source = "Google Open Buildings 2.5D (2023), re-keyed from Overture 2024 ids"
    else:
        cells, bbox = grid_from_ee(bbox_for(args.region), args.level)
        source = f"Google Open Buildings 2.5D Temporal ({EE_YEAR}), mean over built pixels"

    out = args.out or os.path.join(OUT_DIR, f"{args.region}_heights_digipin.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    doc = {"level": args.level, "source": source,
           "bbox": [round(v, 5) for v in bbox], "cells": dict(sorted(cells.items()))}
    with open(out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print(f"Wrote {len(cells)} level-{args.level} cells -> {os.path.relpath(out)}")


if __name__ == "__main__":
    main()
