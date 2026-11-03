"""Paved and unpaved streets per block: HeiGIT's road surface dataset for India (street photos + OpenStreetMap, via HDX, ODbL).

HeiGIT (Heidelberg Institute for Geoinformation Technology) classifies every OpenStreetMap road in India as paved or
unpaved, first from its OSM ``surface`` tag and, where that is missing, from a deep-learning model run over Mapillary
street-level photos taken along the road (Randhawa et al. 2024, arXiv 2410.19874). The India file is 14 GB of GeoJSON
with one road per line; ``main --stream`` keeps the roads whose middle point falls in one of the city boxes. Per
lived-in L7 block, over the drivable roads whose middle lies within ``REACH_M`` of its centre (dataset
``road_surface``):

    rs_known_pct     share of road length with a known surface (OSM tag or photo model)
    rs_unpaved_pct   unpaved share of the road length whose surface is known
    rs_unpaved_km    unpaved road km nearby
    rs_photo_pct     share of the known length classified from street photos rather than an OSM tag

Footways, paths, steps and cycleways are left out. Where few roads have photos or tags the unpaved share is noisy, so
blocks with under ``MIN_KNOWN_M`` of known road get no unpaved share.

    python -m pipeline.realestate.roadsurface --csv roads.csv
"""
from __future__ import annotations

import argparse
import csv
import math
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
REACH_M = 500
MIN_KNOWN_M = 300
URL = "https://downloads.ohsome.org/hdx/mapillary_road_surface/heigit_ind_roadsurface_lines.geojson"
SKIP = {"footway", "path", "pedestrian", "steps", "cycleway", "bridleway", "corridor", "elevator", "platform", "proposed",
        "construction", "abandoned", "razed", "bus_stop", "services", "rest_area"}


def _key(la, lo, step):
    return (int(math.floor(la / step)), int(math.floor(lo / step)))


def block_rows(cells, roads, reach=REACH_M, min_known=MIN_KNOWN_M):
    """cells [(code, lat, lng)]; roads [(lat, lng, highway, surface 'paved'/'unpaved'/None, from_photo bool, length_m)]."""
    step = reach / 111_000
    grid = defaultdict(list)
    for r in roads:
        if r[2] in SKIP or not r[5]:
            continue
        grid[_key(r[0], r[1], step)].append(r)
    rows = {}
    for code, la, lo in cells:
        ky, kx = _key(la, lo, step)
        tot = known = unp = photo = 0.0
        cos = math.cos(math.radians(la))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for r in grid.get((ky + dy, kx + dx), ()):
                    if math.hypot((r[0] - la) * 111_000, (r[1] - lo) * 111_000 * cos) > reach:
                        continue
                    tot += r[5]
                    if r[3] in ("paved", "unpaved"):
                        known += r[5]
                        unp += r[5] if r[3] == "unpaved" else 0
                        photo += r[5] if r[4] else 0
        if tot <= 0:
            continue
        row = {"rs_known_pct": round(100 * known / tot), "rs_unpaved_km": round(unp / 1000, 2)}
        if known >= min_known:
            row["rs_unpaved_pct"] = round(100 * unp / known)
            row["rs_photo_pct"] = round(100 * photo / known)
        rows[code] = row
    return rows


def read_csv(path, region):
    """Rows of the filtered CSV for one region -> road tuples. 'from photo' = combined label set but no OSM surface class."""
    out = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["region"] != region:
                continue
            surf = r["combined"] if r["combined"] in ("paved", "unpaved") else None
            photo = surf is not None and r["osm_class"] in ("", "None")
            out.append((float(r["lat"]), float(r["lng"]), r["highway"], surf, photo, float(r["length_m"] or 0)))
    return out


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("rs_unpaved_pct", "Unpaved share of nearby roads with a known surface", agg="mean", unit="%", domain=[0, 60], ramp="reds", higher_is="worse"),
        FieldSpec("rs_unpaved_km", "Unpaved road length within 500 m", agg="mean", unit="km", ramp="reds", higher_is="worse"),
        FieldSpec("rs_known_pct", "Share of nearby road length with a known surface", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None),
        FieldSpec("rs_photo_pct", "Share of the known surface read from street photos", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="road_surface", title="Paved and unpaved roads (HeiGIT, street photos + OSM)", level=LEVEL, fields=specs, group="Mobility",
        description="Share of the drivable roads within 500 m of each block that are unpaved, from HeiGIT's India road surface "
                    "dataset: the OpenStreetMap surface tag where there is one, otherwise a deep-learning reading of Mapillary "
                    "street photos (via the Humanitarian Data Exchange).",
        source="pipeline/realestate/roadsurface.py (HeiGIT Mapillary road surface for India via HDX)",
        license="ODbL (© OpenStreetMap contributors; HeiGIT road surface predictions from Mapillary imagery)",
        default_field="rs_unpaved_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--csv", required=True, help="roads filtered to the city boxes (region,lat,lng,highway,combined,osm_class,pred,length_m)")
    ap.add_argument("--region")
    a = ap.parse_args(argv)
    regions = a.region.split(",") if a.region else sorted({r["region"] for r in csv.DictReader(open(a.csv, newline=""))})
    for region in regions:
        roads = read_csv(a.csv, region)
        rows = block_rows(lived_cells(region), roads)
        if not rows:
            continue
        info = cell_dataset(region, rows)
        sh = [r["rs_unpaved_pct"] for r in rows.values() if "rs_unpaved_pct" in r]
        print(f"{region}: {len(roads)} roads, {len(rows)} blocks, {len(sh)} with a known surface share, "
              f"{sum(1 for s in sh if s >= 20)} with 20%+ unpaved; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
