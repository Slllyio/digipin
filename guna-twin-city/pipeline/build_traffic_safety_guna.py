"""Generate the Guna Traffic (LOS) + Law-&-Order Mobility datasets and publish
them to the frontend.

The TrafficOverlay and MobilityOverlay modules load precomputed per-region files:
    data/traffic/<region>/road_los.geojson + traffic_grid.json
    data/safety/<region>/chokepoints.geojson + mobility_grid.json
Guna had none, so both overlays 404'd and fell back to slow live Overpass. This
runs the existing pipelines for region='guna' (reusing the committed
osm_roads_guna.geojson + Overpass safety fetch) and copies the outputs under
guna-twin-city/data/ where the page serves them.

Run:  python guna-twin-city/pipeline/build_traffic_safety_guna.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("DIGIPIN_REGION", "guna")

REPO = Path(__file__).resolve().parents[2]
GUNA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

REGION = "guna"
SRC_TRAFFIC = REPO / "data" / "traffic" / REGION
SRC_SAFETY = REPO / "data" / "safety" / REGION
DST_TRAFFIC = GUNA / "data" / "traffic" / REGION
DST_SAFETY = GUNA / "data" / "safety" / REGION


def ensure_roads():
    """road_network/mobility read repo-root data/vectors/osm_roads_guna.geojson."""
    root = REPO / "data" / "vectors" / "osm_roads_guna.geojson"
    if not root.exists():
        local = GUNA / "data" / "vectors" / "osm_roads_guna.geojson"
        if not local.exists():
            raise SystemExit("missing osm_roads_guna.geojson in both data/vectors and guna-twin-city")
        root.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(local, root)
        print("staged osm_roads_guna.geojson to repo data/vectors/")


def build_traffic():
    from pipeline.traffic import road_network, traffic_grid
    from pipeline._lib.regions import bbox_for

    road_network.run(region=REGION)                       # -> road_los.geojson + summary.json
    los = json.loads((SRC_TRAFFIC / "road_los.geojson").read_text())
    grid = traffic_grid.bin_segments(los.get("features", []), bbox_for(REGION), 200)
    (SRC_TRAFFIC / "traffic_grid.json").write_text(json.dumps(grid, separators=(",", ":")))
    print(f"traffic: {len(los.get('features', []))} road segments, grid {grid['nx']}x{grid['ny']}")


def build_safety():
    from pipeline.safety import fetch_osm_safety, mobility
    fetch_osm_safety.fetch(region=REGION)                 # -> data/vectors/osm_safety_guna.geojson
    mobility.run(region=REGION)                           # -> chokepoints.geojson + mobility_grid.json
    print("safety: chokepoints + mobility grid built")


def publish():
    for src, dst in ((SRC_TRAFFIC, DST_TRAFFIC), (SRC_SAFETY, DST_SAFETY)):
        dst.mkdir(parents=True, exist_ok=True)
        for f in src.glob("*"):
            if f.suffix in (".geojson", ".json"):
                shutil.copyfile(f, dst / f.name)
                print(f"published {f.name} -> {dst}")


def main():
    ensure_roads()
    build_traffic()
    build_safety()
    publish()


if __name__ == "__main__":
    main()
