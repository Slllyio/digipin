"""OpenStreetMap amenities, roads and buildings per DIGIPIN cell.

    python -m pipeline.cells.osm_layers --region bhopal --pbf bhopal.osm.pbf
    python -m pipeline.cells.osm_layers --region all          # downloads Geofabrik zones

One streaming pyosmium pass over a bbox-clipped extract fills two datasets:

* ``osm_amenities`` (L7): points of interest per cell in each of the score
  pipeline's categories (pipeline/scores/osm_classify.py, the same classifier
  the app uses), so counts here match what the score engine sees.
* ``osm_roads`` (L7): road length per km² by class (each segment is credited to
  the cell holding its midpoint), junction count, building count and
  building-footprint cover.

Without ``--pbf`` the Geofabrik zone extract is downloaded once per zone and
clipped per city with the ``osmium`` CLI, like pipeline/scores/build_cities.py.
Requires pyosmium (and osmium-tool for the download path).
"""
from __future__ import annotations

import argparse
import json
import math
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

from pipeline._lib import digipin, regions
from pipeline.cells import store
from pipeline.cells.earthengine import cell_area_km2
from pipeline.cells.schema import DatasetSpec, FieldSpec
from pipeline.scores import osm_classify

REPO = Path(__file__).resolve().parents[2]
LEVEL = 7
GROUP = "Open Data (OpenStreetMap)"

CATEGORIES = ["food", "shopping", "healthcare", "education", "transport", "finance",
              "leisure", "entertainment", "accommodation", "government", "business"]
_CAT_LABEL = {"food": "Food & drink", "shopping": "Shops", "healthcare": "Healthcare",
              "education": "Education", "transport": "Transport stops & stations",
              "finance": "Banks & ATMs", "leisure": "Parks & leisure",
              "entertainment": "Entertainment", "accommodation": "Hotels & stays",
              "government": "Government & civic", "business": "Offices & business"}

ROAD_CLASS = {
    "motorway": "major", "trunk": "major", "primary": "major",
    "motorway_link": "major", "trunk_link": "major", "primary_link": "major",
    "secondary": "secondary", "tertiary": "secondary",
    "secondary_link": "secondary", "tertiary_link": "secondary",
    "residential": "local", "unclassified": "local", "living_street": "local",
    "service": "local", "road": "local",
    "footway": "path", "path": "path", "pedestrian": "path", "cycleway": "path",
    "steps": "path", "track": "path",
}
_M_PER_DEG = 111_320.0


def _code(lat, lon):
    try:
        return digipin.encode(lat, lon).replace("-", "")[:LEVEL]
    except ValueError:
        return None


def _seg_m(a, b):
    """Equirectangular segment length in metres (exact enough below ~1 km)."""
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((b[0] - a[0]) * _M_PER_DEG, (b[1] - a[1]) * _M_PER_DEG * k)


def _ring_area_m2(pts):
    """Shoelace area of a closed lat/lng ring, in m²."""
    if len(pts) < 4:
        return 0.0
    lat0 = sum(p[0] for p in pts) / len(pts)
    k = math.cos(math.radians(lat0))
    xy = [(p[1] * _M_PER_DEG * k, p[0] * _M_PER_DEG) for p in pts]
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(xy, xy[1:]))) / 2


def scan(pbf_path: str, bbox=None) -> dict:
    """{code: Counter} of per-cell tallies from one pass over an extract.

    Keys: ``cat:<category>`` POI counts, ``poi`` (any classified feature),
    ``road_<class>_m`` lengths, ``junctions``, ``buildings``, ``bldg_m2``.
    """
    import osmium

    cells: dict = defaultdict(Counter)
    node_use: Counter = Counter()          # road-node reference counts → junctions
    node_loc: dict = {}

    def inside(lat, lon):
        return bbox is None or (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3])

    def poi(lat, lon, tags):
        if not (osm_classify.RELEVANT_KEYS & tags.keys()) or not inside(lat, lon):
            return
        feats = osm_classify.classify_tags(tags)
        if not feats:
            return
        code = _code(lat, lon)
        if code is None:
            return
        cats = {osm_classify.FEAT_TO_CAT[f] for f in feats} & set(CATEGORIES)
        for c in cats:
            cells[code][f"cat:{c}"] += 1
        if cats:
            cells[code]["poi"] += 1

    for o in osmium.FileProcessor(pbf_path).with_locations():
        if o.is_node():
            if o.location.valid() and len(o.tags):
                poi(o.location.lat, o.location.lon, dict(o.tags))
            continue
        if not o.is_way():
            continue
        pts = [(n.location.lat, n.location.lon, n.ref) for n in o.nodes if n.location.valid()]
        if not pts:
            continue
        tags = dict(o.tags)
        hw = tags.get("highway")
        cls = ROAD_CLASS.get(hw) if hw else None
        if cls and tags.get("area") != "yes":
            for a, b in zip(pts, pts[1:]):
                mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                if not inside(*mid):
                    continue
                code = _code(*mid)
                if code:
                    cells[code][f"road_{cls}_m"] += _seg_m(a, b)
            if cls != "path":
                for p in {p[2]: p for p in pts}.values():
                    node_use[p[2]] += 1
                    node_loc[p[2]] = (p[0], p[1])
        lats, lons = [p[0] for p in pts], [p[1] for p in pts]
        lat, lon = (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2
        if tags.get("building") and tags["building"] != "no" and inside(lat, lon):
            code = _code(lat, lon)
            if code:
                cells[code]["buildings"] += 1
                if pts[0][2] == pts[-1][2]:
                    cells[code]["bldg_m2"] += _ring_area_m2([(p[0], p[1]) for p in pts])
        if tags:
            poi(lat, lon, tags)

    # A junction is a road node shared by two or more drivable ways.
    for ref, n in node_use.items():
        if n >= 2:
            code = _code(*node_loc[ref])
            if code and inside(*node_loc[ref]):
                cells[code]["junctions"] += 1
    return cells


def amenity_dataset(cells: dict):
    specs = [FieldSpec("poi_total", "All points of interest", agg="sum", unit="count",
                       ramp="heat")]
    specs += [FieldSpec(c, _CAT_LABEL[c], agg="sum", unit="count",
                        ramp="greens" if c in ("healthcare", "education", "leisure") else "viridis",
                        higher_is="better" if c in ("healthcare", "education", "leisure",
                                                    "transport") else None)
              for c in CATEGORIES]
    rows = []
    for code, t in cells.items():
        if not t.get("poi"):
            continue
        r = {"digipin": code, "poi_total": t["poi"]}
        r.update({c: t.get(f"cat:{c}", 0) for c in CATEGORIES})
        rows.append(r)
    spec = DatasetSpec(
        id="osm_amenities", title="Amenities (OpenStreetMap)", level=LEVEL, fields=specs,
        group=GROUP,
        description="Points of interest per cell in each category of the score engine's OSM "
                    "classifier (pipeline/scores/osm_classify.py). Counts reflect OSM mapping "
                    "completeness as well as reality.",
        source="OpenStreetMap via Geofabrik extract (pipeline/cells/osm_layers.py)",
        license="ODbL (© OpenStreetMap contributors)",
        default_field="poi_total", extrude=True, height_m=400)
    return spec, store.bin_records(rows, LEVEL, specs)


def roads_dataset(cells: dict):
    specs = [
        FieldSpec("road_km_km2", "Road density (all drivable)", agg="mean", unit="km/km²",
                  ramp="viridis"),
        FieldSpec("major_km_km2", "Major roads (motorway–primary)", agg="mean", unit="km/km²",
                  ramp="reds"),
        FieldSpec("secondary_km_km2", "Secondary & tertiary roads", agg="mean", unit="km/km²",
                  ramp="viridis"),
        FieldSpec("local_km_km2", "Local & residential streets", agg="mean", unit="km/km²",
                  ramp="viridis"),
        FieldSpec("path_km_km2", "Footpaths & cycleways", agg="mean", unit="km/km²",
                  ramp="greens", higher_is="better"),
        FieldSpec("junctions_km2", "Street junctions", agg="mean", unit="per km²",
                  ramp="viridis", higher_is="better"),
        FieldSpec("buildings", "Mapped buildings", agg="sum", unit="count", ramp="heat"),
        FieldSpec("building_cover_pct", "Building footprint cover", agg="mean",
                  unit="% of cell", domain=[0, 80], ramp="heat"),
    ]
    rows = []
    for code, t in cells.items():
        a = cell_area_km2(code)
        km = {c: t.get(f"road_{c}_m", 0) / 1000 for c in ("major", "secondary", "local", "path")}
        drive = km["major"] + km["secondary"] + km["local"]
        if drive == 0 and km["path"] == 0 and not t.get("buildings"):
            continue
        rows.append({
            "digipin": code,
            "road_km_km2": round(drive / a, 2),
            "major_km_km2": round(km["major"] / a, 2),
            "secondary_km_km2": round(km["secondary"] / a, 2),
            "local_km_km2": round(km["local"] / a, 2),
            "path_km_km2": round(km["path"] / a, 2),
            "junctions_km2": round(t.get("junctions", 0) / a, 1),
            "buildings": t.get("buildings", 0),
            "building_cover_pct": round(min(100.0, 100 * t.get("bldg_m2", 0) / (a * 1e6)), 1),
        })
    spec = DatasetSpec(
        id="osm_roads", title="Roads & buildings (OpenStreetMap)", level=LEVEL, fields=specs,
        group=GROUP,
        description="Road length per km² by class (segments credited to the cell of their "
                    "midpoint), junction density, and mapped building count and footprint "
                    "cover from OpenStreetMap.",
        source="OpenStreetMap via Geofabrik extract (pipeline/cells/osm_layers.py)",
        license="ODbL (© OpenStreetMap contributors)",
        default_field="road_km_km2")
    return spec, store.bin_records(rows, LEVEL, specs)


def build_region(region: str, pbf: str, out: str, parquet: bool = True) -> list:
    bbox = regions.bbox_for(region)
    cells = scan(pbf, bbox)
    return [store.write_dataset(out, spec, region, table, parquet=parquet)
            for spec, table in (amenity_dataset(cells), roads_dataset(cells))]


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Bake OSM amenities/roads into the cell store.")
    p.add_argument("--region", default="all", help="region, comma list, or 'all'")
    p.add_argument("--pbf", help="a clipped .osm.pbf for a single --region (skips download)")
    p.add_argument("--out", default=str(REPO / "data" / "cells"))
    p.add_argument("--no-parquet", action="store_true")
    a = p.parse_args(argv)
    names = list(regions.CITY_PILOTS) if a.region == "all" else a.region.split(",")
    if a.pbf:
        if len(names) != 1:
            p.error("--pbf needs exactly one --region")
        for res in build_region(names[0], a.pbf, a.out, not a.no_parquet):
            print(json.dumps(res), flush=True)
        return 0

    from pipeline.scores.build_cities import _download, _run, group_by_zone
    failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for zone, cities in group_by_zone(names).items():
            zpbf = work / f"{zone}.osm.pbf"
            if not _download(f"{regions._GEOFABRIK_BASE}/{zone}-latest.osm.pbf", zpbf):
                failed += len(cities)
                continue
            for region in cities:
                cpbf = work / f"{region}.osm.pbf"
                _run(["osmium", "extract", "-b", regions.clip_bbox_str(region, 0),
                      str(zpbf), "-o", str(cpbf), "--overwrite"])
                for res in build_region(region, str(cpbf), a.out, not a.no_parquet):
                    print(json.dumps(res), flush=True)
                cpbf.unlink(missing_ok=True)
            zpbf.unlink(missing_ok=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
