"""One-shot Indore-scoped GEE extractor for all 4 DigiPin COG layers.

The existing per-layer scripts in pipeline/growth/ and pipeline/heat/
use GEE's Drive-export workflow, which is fine for India-wide pulls
but overkill for the Indore pilot (~1800 km²). For the pilot bbox,
`ee.Image.getDownloadURL` returns a signed URL within ~10 s — we can
stream the GeoTIFF directly to disk and skip the Drive round-trip.

This script extracts the 4 layers DigiPin's frontend needs:

    data/growth/buildings_temporal_2016-2023_indore_pilot.tif  (8 bands)
    data/growth/viirs_2016-2024_indore_pilot.tif               (9 bands)
    data/growth/ghsl_pop_2020_indore_pilot.tif                 (1 band)
    data/heat/modis_lst_2016-2024_indore_pilot.tif             (18 bands)

After running, the Growth + Heat overlays in the portal should switch
from the "data missing" toast to real coloured per-cell heatmaps.

Region: defaults to INDORE_PILOT from pipeline._lib.regions. Override
with DIGIPIN_REGION=india_full (not recommended — pulls 3.2M km² and
will time out the getDownloadURL endpoint).

Usage:
    python pipeline/extract_indore_cogs.py                # all 4 layers
    python pipeline/extract_indore_cogs.py --layers heat  # just MODIS
    python pipeline/extract_indore_cogs.py -v             # verbose
"""

from __future__ import annotations

import argparse
import io
import logging
import os
import sys
import time
from pathlib import Path
from urllib.request import urlopen, Request

# Make the script runnable both ways:
#   python pipeline/extract_indore_cogs.py
#   python -m pipeline.extract_indore_cogs
# The first form needs the project root on sys.path to resolve `pipeline.*`.
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from pipeline._lib.regions import get_default_bbox, get_default_region_name

log = logging.getLogger("pipeline.extract_indore_cogs")

# Per-layer extraction config: GEE asset, year span, band-builder.
# All layers clip to the same INDORE_PILOT bbox; scale is per-source.
LAYER_BUILDERS = {}


def _build_buildings_temporal(ee, region):
    """Google Open Buildings Temporal v1 — annual building presence layers.

    Source: GOOGLE/Research/open-buildings-temporal/v1 (4 m resolution).
    Available bands per the asset's actual schema: `building_fractional_count`,
    `building_height`, `building_presence`. We use `building_presence`
    which is the per-pixel probability that a building exists in that
    year — directly maps to the Growth score's BUE sub-score.

    Downsampled to 30 m for the Indore pilot so the file stays small
    and georaster.js loads it in one shot.
    """
    coll = ee.ImageCollection("GOOGLE/Research/open-buildings-temporal/v1")
    bands = []
    for year in range(2016, 2024):
        annual = coll.filterDate(f"{year}-01-01", f"{year}-12-31")
        b = annual.select("building_presence").median().rename(f"buildings_{year}")
        bands.append(b)
    # 100 m scale keeps the 8-band Indore-pilot image under the 48 MB
    # getDownloadURL cap. At Indore bbox (~40 km × 45 km) that's
    # 400 × 450 × 8 bands ~= 5.7 MB.
    return ee.Image.cat(bands).clip(region), 100


def _build_viirs_annual(ee, region):
    """NOAA VIIRS DNB monthly composites → annual mean radiance.

    Source: NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG. 9 years 2016-2024.
    100 m native resolution; we keep 100 m.
    """
    coll = ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG")
    bands = []
    for year in range(2016, 2025):
        annual = coll.filterDate(f"{year}-01-01", f"{year}-12-31")
        b = annual.select("avg_rad").mean().rename(f"viirs_{year}")
        bands.append(b)
    return ee.Image.cat(bands).clip(region), 100


def _build_ghsl_pop(ee, region):
    """JRC GHSL P2023A population density, 2020 epoch.

    Single-band image; 100 m native.
    """
    img = ee.Image("JRC/GHSL/P2023A/GHS_POP/2020")
    return img.clip(region), 100


def _build_modis_lst(ee, region):
    """MODIS Aqua/Terra Land Surface Temperature daily, 1 km.

    Source: MODIS/061/MOD11A1. 9 years × (day + night) = 18 bands.
    Day band = LST_Day_1km · 0.02 K, Night = LST_Night_1km · 0.02 K
    (the GEE asset's native scale).
    """
    coll = ee.ImageCollection("MODIS/061/MOD11A1")
    bands = []
    for year in range(2016, 2025):
        annual = coll.filterDate(f"{year}-01-01", f"{year}-12-31")
        day = annual.select("LST_Day_1km").mean().rename(f"lst_day_{year}")
        night = annual.select("LST_Night_1km").mean().rename(f"lst_night_{year}")
        bands.extend([day, night])
    return ee.Image.cat(bands).clip(region), 1000


# Public layer registry — ordered by output path.
LAYER_BUILDERS["growth_buildings"] = {
    "build": _build_buildings_temporal,
    "out": "data/growth/buildings_temporal_2016-2023_{region}.tif",
    "desc": "Google Open Buildings Temporal v1 (8 years)",
}
LAYER_BUILDERS["growth_viirs"] = {
    "build": _build_viirs_annual,
    "out": "data/growth/viirs_2016-2024_{region}.tif",
    "desc": "NOAA VIIRS annual mean radiance (9 years)",
}
LAYER_BUILDERS["growth_ghsl"] = {
    "build": _build_ghsl_pop,
    "out": "data/growth/ghsl_pop_2020_{region}.tif",
    "desc": "JRC GHSL P2023A population density 2020",
}
LAYER_BUILDERS["heat_modis"] = {
    "build": _build_modis_lst,
    "out": "data/heat/modis_lst_2016-2024_{region}.tif",
    "desc": "MODIS LST day+night annual mean (9 years × 2 = 18 bands)",
}


def _init_ee():
    """Reuse the dual-path init from pipeline/_lib/regions.py callers."""
    import ee
    project = os.environ.get("GEE_PROJECT", "van-suraksha-alert")
    cred = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred and Path(cred).is_file():
        ee.Initialize(ee.ServiceAccountCredentials(None, cred), project=project)
        log.info("EE init via service account, project=%s", project)
    else:
        ee.Initialize(project=project)
        log.info("EE init via cached OAuth, project=%s", project)


def _download_image(image, scale_m: int, region, dest: Path) -> int:
    """Stream-download the GEE image as a Cloud-Optimised GeoTIFF.

    `getDownloadURL` returns a signed URL that streams the rendered
    image as a zipped GeoTIFF. The endpoint has a soft cap of ~32 MB
    per response, which fits the Indore pilot bbox at every scale
    we use (1km MODIS = ~30 KB, 100m VIIRS/GHSL = ~5 MB, 30m
    buildings = ~25 MB).
    """
    url = image.getDownloadURL({
        "scale": scale_m,
        "region": region,
        "format": "GEO_TIFF",
        "crs": "EPSG:4326",
    })
    log.info("    signed URL ready (%s)", url[:80] + "...")
    req = Request(url, headers={"User-Agent": "DigiPin-Indore-Pilot-Extractor/1.0"})
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urlopen(req, timeout=300) as r:
        bytes_read = 0
        with tmp.open("wb") as f:
            while True:
                buf = r.read(256 * 1024)
                if not buf:
                    break
                f.write(buf)
                bytes_read += len(buf)
    tmp.replace(dest)
    return bytes_read


def extract_layer(name: str, ee, bbox, region_name: str) -> dict:
    cfg = LAYER_BUILDERS[name]
    out_path = Path(cfg["out"].format(region=region_name))
    log.info("[%s] %s", name, cfg["desc"])
    log.info("    out: %s", out_path)
    if out_path.is_file():
        existing = out_path.stat().st_size
        log.info("    already on disk (%.1f MB) — skipping. Delete to re-extract.", existing / 1e6)
        return {"layer": name, "skipped": True, "bytes": existing, "path": str(out_path)}

    region = ee.Geometry.Rectangle(bbox, "EPSG:4326", False)
    t0 = time.time()
    image, scale_m = cfg["build"](ee, region)
    log.info("    image built; downloading at %d m scale ...", scale_m)
    n_bytes = _download_image(image, scale_m, region, out_path)
    log.info("    %.1f MB in %.1f s", n_bytes / 1e6, time.time() - t0)
    return {"layer": name, "skipped": False, "bytes": n_bytes, "path": str(out_path)}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--layers", nargs="+", choices=list(LAYER_BUILDERS) + ["all"], default=["all"])
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(message)s",
        datefmt="%H:%M:%S",
    )

    _init_ee()
    import ee

    bbox = get_default_bbox()
    region_name = get_default_region_name()
    log.info("region=%s bbox=%s", region_name, bbox)

    layers = list(LAYER_BUILDERS) if "all" in args.layers else args.layers
    results = []
    total_bytes = 0
    for name in layers:
        try:
            r = extract_layer(name, ee, bbox, region_name)
            results.append(r)
            total_bytes += r["bytes"]
        except Exception as e:
            log.exception("[%s] FAILED: %s", name, e)
            results.append({"layer": name, "error": str(e)})

    log.info("done. %d layers, %.1f MB total", len(results), total_bytes / 1e6)
    for r in results:
        if "error" in r:
            log.error("  %-20s FAILED: %s", r["layer"], r["error"])
        else:
            kind = "cached " if r.get("skipped") else "fetched"
            log.info("  %-20s %s %.1f MB %s", r["layer"], kind, r["bytes"] / 1e6, r["path"])
    return 0 if all("error" not in r for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
