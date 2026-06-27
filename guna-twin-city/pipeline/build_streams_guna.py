"""Identify Guna's stream / river NETWORK via GEE hydrology (MERIT Hydro).

The JRC surface-water layer only shows where standing water sits (river core +
tanks) — it's not a connected stream network, and vectorising it gives blocky
disconnected cells. MERIT Hydro (`MERIT/Hydro/v1_0_1`) instead carries the
drainage topology:
  * `upa` = upstream drainage area (km²)  — how much land flows through a cell
  * `dir` = D8 flow direction            — which neighbour the water flows to

We threshold `upa` to pick stream cells, then trace each stream cell to its
downstream neighbour via `dir`. Because adjacent segments share endpoints, the
union is a CONNECTED network (the Guniya trunk + every tributary) — true water
PATHWAYS, not blobs. Each segment carries its `upa` so the renderer can size it
by hydraulic geometry (channel width ∝ √drainage-area) and a coarse `tier`.

Tiers (upstream drainage area, km²):
  >= 30  -> "river"   (main channel, e.g. the Guniya)
  >= 4   -> "stream"
  >= 0.6 -> "brook"   (small tributaries)

Output (committed):  data/vectors/streams_guna.geojson  (LineString network)

Run:  python guna-twin-city/pipeline/build_streams_guna.py
"""
from __future__ import annotations

import io
import json
import math
import os
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.transform import xy

GUNA = Path(__file__).resolve().parents[1]
OUT = GUNA / "data" / "vectors" / "streams_guna.geojson"
BBOX = (77.22, 24.54, 77.41, 24.73)        # w, s, e, n — buffered scene extent
MIN_UPA = 0.6                               # km² — smallest tributary to keep
TIERS = (("river", 30.0), ("stream", 4.0), ("brook", 0.6))

# MERIT D8 flow direction -> (drow, dcol). Row index increases southward.
DIRS = {1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1),
        16: (0, -1), 32: (-1, -1), 64: (-1, 0), 128: (-1, 1)}


def _init_ee():
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
    else:
        ee.Initialize(project=project)
    return ee


def _fetch(ee, bands):
    img = ee.Image("MERIT/Hydro/v1_0_1").select(bands)
    region = ee.Geometry.Rectangle(list(BBOX), "EPSG:4326", False)
    url = img.clip(region).getDownloadURL({
        "region": region, "scale": 90, "crs": "EPSG:4326",
        "format": "GEO_TIFF", "maxPixels": 1e9,
    })
    blob = requests.get(url, timeout=180).content
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            blob = zf.read(next(n for n in zf.namelist() if n.lower().endswith(".tif")))
    return blob


def _tier(upa: float) -> str:
    for name, thr in TIERS:
        if upa >= thr:
            return name
    return "brook"


def main():
    ee = _init_ee()
    blob = _fetch(ee, ["upa", "dir"])
    tmp = GUNA / "data" / "rasters" / "merit_hydro_guna.tif"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(blob)
    with rasterio.open(tmp) as s:
        upa = s.read(1).astype("float32")
        fdir = s.read(2).astype("int32")
        tr = s.transform
    rows, cols = upa.shape
    print(f"upa raster {upa.shape}, max drainage {upa.max():.1f} km², "
          f"stream cells (>= {MIN_UPA}): {(upa >= MIN_UPA).sum()}")

    # Trace each stream cell to its downstream neighbour -> connected segments.
    feats = []
    rr, cc = np.where(upa >= MIN_UPA)
    for r, c in zip(rr.tolist(), cc.tolist()):
        d = int(fdir[r, c])
        if d not in DIRS:                      # 0 mouth / -1 sink / nodata
            continue
        dr, dc = DIRS[d]
        r2, c2 = r + dr, c + dc
        if not (0 <= r2 < rows and 0 <= c2 < cols):
            continue
        x1, y1 = xy(tr, r, c)                   # cell centres (lng, lat)
        x2, y2 = xy(tr, r2, c2)
        u = round(float(upa[r, c]), 2)
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString",
                         "coordinates": [[round(x1, 6), round(y1, 6)],
                                         [round(x2, 6), round(y2, 6)]]},
            "properties": {"upa": u, "tier": _tier(u)},
        })
    if not feats:
        raise SystemExit("no stream segments traced — check thresholds / bands")
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                              separators=(",", ":")), encoding="utf-8")
    by = Counter(f["properties"]["tier"] for f in feats)
    print(f"wrote {OUT.name}: {len(feats)} segments {dict(by)}, "
          f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
