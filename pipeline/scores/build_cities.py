"""Batch-build precomputed score tiles, grouping cities by Geofabrik zone.

Each zonal extract (~GB) is downloaded once and reused for every city in that
zone; then each city is clipped (``osmium extract``), its Copernicus GLO-30 DEM
tiles fetched and mosaicked, and ``build_tile`` + ``smoke_check`` run. This is
the local/batch path; CI builds one city at a time via
``.github/workflows/precompute-scores.yml``.

Requires the ``osmium`` CLI on PATH (``apt-get install osmium-tool``) plus the
pipeline deps (``pipeline/scores/requirements.txt``). The OSM extract host
(download.geofabrik.de) must be reachable.

Usage::

    python -m pipeline.scores.build_cities                  # all city pilots
    python -m pipeline.scores.build_cities pune mumbai      # a subset
    python -m pipeline.scores.build_cities --level 6 --out data/scores
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path

from pipeline._lib import regions
from pipeline.scores import build_tile, smoke_check


def group_by_zone(names: list[str]) -> dict[str, list[str]]:
    """Map each Geofabrik zone to the requested cities that live in it."""
    g: dict[str, list[str]] = defaultdict(list)
    for n in names:
        g[regions._GEOFABRIK_ZONE[n]].append(n)
    return dict(g)


def _run(cmd: list[str]) -> None:
    print("  $", " ".join(cmd))
    subprocess.run(cmd, check=True)


def _download(url: str, dest: Path, retries: int = 3) -> bool:
    for i in range(1, retries + 1):
        try:
            _run(["curl", "-sSL", "--retry", "3", "-o", str(dest), url])
        except subprocess.CalledProcessError:
            pass
        if dest.exists() and dest.stat().st_size > 0:
            return True
        print(f"  download attempt {i}/{retries} failed: {url}")
    return False


def _fetch_dem(region: str, work: Path) -> str | None:
    """Download the region's GLO-30 tiles; mosaic if >1. None → OSM-only build."""
    tifs: list[Path] = []
    for url in regions.dem_tile_urls(region):
        f = work / f"dem_{region}_{Path(url).name}"
        if _download(url, f, retries=2):
            tifs.append(f)
    if not tifs:
        print(f"  DEM unavailable for {region} — building OSM-only (flood-risk baseline).")
        return None
    if len(tifs) == 1:
        return str(tifs[0])
    import rasterio
    from rasterio.merge import merge

    srcs = [rasterio.open(t) for t in tifs]
    try:
        mosaic, transform = merge(srcs)
        meta = srcs[0].meta.copy()
        meta.update(height=mosaic.shape[1], width=mosaic.shape[2], transform=transform)
        out = work / f"dem_{region}_mosaic.tif"
        with rasterio.open(out, "w", **meta) as dst:
            dst.write(mosaic)
    finally:
        for s in srcs:
            s.close()
    print(f"  DEM: mosaicked {len(tifs)} tiles for {region}.")
    return str(out)


def build_cities(names: list[str], level: int, out_dir: str,
                 keep_pbf: bool = False, pmtiles: bool = True) -> list[dict]:
    by_zone = group_by_zone(names)
    work = Path(tempfile.mkdtemp(prefix="digipin_tiles_"))
    results: list[dict] = []
    try:
        for zone, cities in by_zone.items():
            print(f"\n== zone {zone}: {cities} ==")
            zpbf = work / f"{zone}.osm.pbf"
            url = f"{regions._GEOFABRIK_BASE}/{zone}-latest.osm.pbf"
            if not _download(url, zpbf):
                print(f"!! could not download {url}; skipping {cities}")
                continue
            for region in cities:
                print(f"\n-- {region} --")
                cpbf = work / f"{region}.osm.pbf"
                _run(["osmium", "extract", "-b", regions.clip_bbox_str(region),
                      str(zpbf), "-o", str(cpbf), "--overwrite"])
                dem = _fetch_dem(region, work)
                summary = build_tile.build(region, level, out_dir,
                                           pbf=str(cpbf), dem=dem, pmtiles=pmtiles)
                chk = smoke_check.check(out_dir, region)
                print(f"  OK {region}: {summary['cells']} cells, "
                      f"{chk['distinct']} distinct score vectors, pmtiles={chk['pmtiles']}")
                results.append({"region": region, **summary, "distinct": chk["distinct"]})
                cpbf.unlink(missing_ok=True)
            if not keep_pbf:
                zpbf.unlink(missing_ok=True)
    finally:
        if not keep_pbf:
            shutil.rmtree(work, ignore_errors=True)
    return results


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Batch-build precomputed score tiles by zone.")
    p.add_argument("regions", nargs="*", help="region names (default: all city pilots)")
    p.add_argument("--level", type=int, default=6)
    p.add_argument("--out", default="data/scores")
    p.add_argument("--keep-pbf", action="store_true", help="keep downloaded extracts")
    p.add_argument("--no-pmtiles", action="store_true", help="skip the PMTiles choropleth")
    a = p.parse_args(argv)

    names = a.regions or list(regions.CITY_PILOTS)
    unknown = [n for n in names if n not in regions._GEOFABRIK_ZONE]
    if unknown:
        p.error(f"unknown/unsupported regions {unknown}; choose from {list(regions.CITY_PILOTS)}")

    res = build_cities(names, a.level, a.out, keep_pbf=a.keep_pbf, pmtiles=not a.no_pmtiles)
    print(f"\nDone: built {len(res)}/{len(names)} tiles -> {a.out}")
    for r in res:
        print(f"  {r['region']:14} {r['cells']:>6} cells")
    return 0 if len(res) == len(names) else 1


if __name__ == "__main__":
    raise SystemExit(main())
