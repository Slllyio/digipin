"""Afternoon surface heat per block from NASA ECOSTRESS (on the International Space Station; NASA open data, no
restrictions).

Landsat and Sentinel cross Indian cities around 10:30 in the morning, before the ground is at its hottest. ECOSTRESS rides
the ISS's drifting orbit, so it also sees cities between 12:30 and 16:30 local time, near the daily peak. This takes every
ECOSTRESS v002 tiled land surface temperature granule (ECO_L2T_LSTE, 70 m) over each city from mid-March to mid-June
(pre-monsoon) 2019-2025 that was acquired 12:30-16:30 IST, masks cloud, and per scene reads each lived-in L7 block's
mean LST and its gap to the scene's median over lived-in blocks. Averaging the gaps removes day-to-day weather
(dataset ``afternoon_heat``):

    pm_lst_c      mean afternoon land surface temperature over the scenes that saw the block (°C)
    pm_anom_c     mean gap to the city's median block in the same scene (°C; + hotter)
    pm_scenes     number of clear afternoon scenes that saw the block

Surface temperature is what roofs, roads and fields reach in the sun, not air temperature.

Granule search uses CMR; downloads use the Earthdata credential (data.lpdaac.earthdatacloud.nasa.gov):

    python -m pipeline.realestate.afternoonheat --region delhi --cache /tmp/claude-0/eco
"""
from __future__ import annotations

import argparse
import json
import statistics
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
YEARS = range(2019, 2026)
SEASON = ("03-15", "06-20")
IST_MIN = (12 * 60 + 30, 16 * 60 + 30)  # local acquisition window
MIN_SCENE_BLOCKS = 200  # a scene must see at least this many lived-in blocks clear of cloud


def ist_minutes(iso):
    """'2024-04-05T08:33:44.000Z' -> minutes after local midnight in IST (UTC+5:30)."""
    return (int(iso[11:13]) * 60 + int(iso[14:16]) + 330) % 1440


def afternoon(iso):
    return IST_MIN[0] <= ist_minutes(iso) <= IST_MIN[1]


def scene_key(title):
    """Granules of one overpass share orbit and scene ids: ECOv002_L2T_LSTE_<orbit>_<scene>_<tile>_<time>_..."""
    p = title.split("_")
    return f"{p[3]}_{p[4]}"


def anomalies(scene_values):
    """[{code: lst_c}] per scene -> {code: (mean lst, mean gap to scene median, n scenes)}."""
    acc = {}
    for vals in scene_values:
        if len(vals) < MIN_SCENE_BLOCKS:
            continue
        med = statistics.median(vals.values())
        for code, v in vals.items():
            a = acc.setdefault(code, [0.0, 0.0, 0])
            a[0] += v
            a[1] += v - med
            a[2] += 1
    return {c: (s / n, g / n, n) for c, (s, g, n) in acc.items()}


def _curl_json(url):
    out = subprocess.run(["curl", "-s", "-m", "120", url], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def granules(bbox):
    w, s, e, n = bbox
    out = []
    for y in YEARS:
        url = (f"{CMR}?short_name=ECO_L2T_LSTE&version=002&bounding_box={w},{s},{e},{n}"
               f"&temporal={y}-{SEASON[0]}T00:00:00Z,{y}-{SEASON[1]}T00:00:00Z&page_size=2000")
        for g in _curl_json(url)["feed"]["entry"]:
            if not afternoon(g["time_start"]):
                continue
            tifs = {l["href"].rsplit("_", 1)[-1]: l["href"] for l in g["links"] if l["href"].endswith(".tif") and l["href"].startswith("https")}
            if "LST.tif" in tifs and "cloud.tif" in tifs:
                out.append((g["title"], tifs["LST.tif"], tifs["cloud.tif"]))
    return out


def _get(url, cache):
    p = Path(cache) / url.rsplit("/", 1)[-1]
    if not p.exists() or p.stat().st_size == 0:
        subprocess.run(["curl", "-s", "-L", "-m", "300", "--retry", "3", "-o", str(p), url], check=True)
    return p


def scene_blocks(files, cells):
    """Read a set of tiles (LST, cloud) for one overpass -> {code: mean LST °C} over lived-in block centres' 3x3 pixels."""
    import numpy as np
    import rasterio
    from rasterio.warp import transform as warp
    vals = {}
    for lst_p, cloud_p in files:
        with rasterio.open(lst_p) as L, rasterio.open(cloud_p) as C:
            lst, cld = L.read(1), C.read(1)
            xs, ys = warp("EPSG:4326", L.crs, [c[2] for c in cells], [c[1] for c in cells])
            for (code, _, _), x, y in zip(cells, xs, ys):
                if code in vals:
                    continue
                r, c = L.index(x, y)
                if not (1 <= r < L.height - 1 and 1 <= c < L.width - 1):
                    continue
                win, cw = lst[r - 1:r + 2, c - 1:c + 2], cld[r - 1:r + 2, c - 1:c + 2]
                ok = np.isfinite(win) & (cw == 0) & (win > 250)
                if ok.sum() >= 5:
                    vals[code] = float(win[ok].mean()) - 273.15
    return vals


def fetch(region, cache):
    from pipeline.realestate.powerplants import lived_cells
    cells = lived_cells(region)
    bbox = (min(c[2] for c in cells), min(c[1] for c in cells), max(c[2] for c in cells), max(c[1] for c in cells))
    by_scene = {}
    for title, lst, cloud in granules(bbox):
        by_scene.setdefault(scene_key(title), []).append((lst, cloud))
    Path(cache).mkdir(parents=True, exist_ok=True)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(8) as pool:  # fetch every tile first, in parallel
        list(pool.map(lambda u: _get(u, cache), [u for tiles in by_scene.values() for pair in tiles for u in pair]))
    scenes = []
    for key, tiles in sorted(by_scene.items()):
        files = [(_get(a, cache), _get(b, cache)) for a, b in tiles]
        scenes.append(scene_blocks(files, cells))
        for a, b in files:  # keep the disk small
            a.unlink(missing_ok=True)
            b.unlink(missing_ok=True)
    res = anomalies(scenes)
    used = sum(1 for s in scenes if len(s) >= MIN_SCENE_BLOCKS)
    return {c: {"pm_lst_c": round(m, 1), "pm_anom_c": round(g, 1), "pm_scenes": n} for c, (m, g, n) in res.items()}, used, len(by_scene)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("pm_lst_c", "Afternoon surface temperature, pre-monsoon (12:30-16:30)", agg="mean", unit="°C", ramp="heat", higher_is="worse"),
        FieldSpec("pm_anom_c", "Afternoon surface heat vs the city's median block", agg="mean", unit="°C", ramp="diverging", higher_is="worse"),
        FieldSpec("pm_scenes", "Clear afternoon ECOSTRESS scenes", agg="min", unit="scenes", ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="afternoon_heat", title="Afternoon surface heat (NASA ECOSTRESS, 2019-2025)", level=LEVEL, fields=specs, group="Environment",
        description="NASA ECOSTRESS v002 land surface temperature (70 m) from every clear pre-monsoon (15 Mar-20 Jun) overpass "
                    "between 12:30 and 16:30 IST, 2019-2025: each block's mean afternoon temperature and its mean gap to the city's "
                    "median block in the same scene. Landsat-based heat layers see only the 10:30 morning pass.",
        source="pipeline/realestate/afternoonheat.py (NASA LP DAAC ECO_L2T_LSTE v002 LST and cloud tiles)",
        license="NASA Earth science data: open, no restrictions (Hook S. & Hulley G., ECOSTRESS L2T LSTE v002, doi:10.5067/ECOSTRESS/ECO_L2T_LSTE.002)",
        default_field="pm_anom_c", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region")
    ap.add_argument("--cache", default="/tmp/claude-0/eco")
    a = ap.parse_args(argv)
    cat = json.loads((CELLS / "catalog.json").read_text())
    regions = a.region.split(",") if a.region else [r["name"] for r in next(d for d in cat["datasets"] if d["id"] == "population")["regions"]]
    for region in regions:
        rows, used, found = fetch(region, a.cache)
        if not rows:
            print(f"{region}: none ({found} scenes found)")
            continue
        info = cell_dataset(region, rows)
        v = sorted(r["pm_lst_c"] for r in rows.values())
        g = sorted(r["pm_anom_c"] for r in rows.values())
        print(f"{region}: {len(v)} blocks from {used}/{found} scenes, afternoon LST median {v[len(v) // 2]} °C, "
              f"gap 10th {g[len(g) // 10]} / 90th {g[9 * len(g) // 10]}; {info['cells']} cells", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
