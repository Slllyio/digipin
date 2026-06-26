"""Rebuild the Guna precomputed score tiles WITH OSM amenity data.

The first Guna score build ran without an OSM extract, so build_tile fell back to
`assemble_data({}, {}, env)` — only the raster-derived fields (flood_risk, a
degenerate livability) were populated and the six amenity-driven KPIs (safety,
green, connectivity, healthcare_access, walkability, commercial) came out 0
across every cell. That left the Score-Grid choropleth and the Ward Dashboard
mostly blank.

Guna isn't in the geofabrik region map, so instead of a ~1 GB state download we
fetch just the metro-bbox extract from Overpass as a .osm file (pyosmium reads
XML as well as .pbf) and feed it to the existing build_tile pipeline alongside
the local WorldPop + SRTM rasters.

Run:  python guna-twin-city/pipeline/build_scores_guna.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parents[2]
GUNA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

# south, west, north, east — buffered past the metro so 400 m cell radii at the
# edge still see their neighbourhood of amenities.
S, W, N, E = 24.56, 77.23, 24.72, 77.42
OSM_OUT = GUNA / "data" / "osm" / "guna.osm"
SCORES_OUT = GUNA / "data" / "scores"
POP = GUNA / "data" / "rasters" / "worldpop_1km_guna.tif"
DEM = GUNA / "data" / "rasters" / "srtm_90m_guna.tif"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
HEADERS = {"User-Agent": "DigiPin-UrbanIntelligence/1.0 (score build)"}


def fetch_osm():
    """Download the Guna bbox as a .osm XML extract (nodes+ways+relations+geometry)."""
    query = f"""[out:xml][timeout:240];
(node({S},{W},{N},{E});way({S},{W},{N},{E});relation({S},{W},{N},{E}););
(._;>;);
out body;"""
    last = None
    for url in ENDPOINTS:
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=300)
            if r.status_code == 200 and r.content[:5] in (b"<?xml", b"<osm "):
                OSM_OUT.parent.mkdir(parents=True, exist_ok=True)
                OSM_OUT.write_bytes(r.content)
                print(f"fetched {OSM_OUT} ({len(r.content)//1024} KB)")
                return
            last = f"{url} -> HTTP {r.status_code}"
        except Exception as ex:
            last = f"{url} -> {ex!r}"
    raise SystemExit(f"Overpass OSM fetch failed: {last}")


def main():
    if not OSM_OUT.exists() or OSM_OUT.stat().st_size < 50_000:
        fetch_osm()
    else:
        print(f"reusing {OSM_OUT} ({OSM_OUT.stat().st_size//1024} KB)")

    from pipeline.scores import build_tile
    summary = build_tile.build(
        region="guna", level=6, out_dir=str(SCORES_OUT),
        pbf=str(OSM_OUT),
        pop=str(POP) if POP.exists() else None,
        dem=str(DEM) if DEM.exists() else None,
        pmtiles=True,
    )
    print("build summary:", summary)


if __name__ == "__main__":
    main()
