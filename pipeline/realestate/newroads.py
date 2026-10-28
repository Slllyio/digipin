"""Big roads to come: planned elevated corridors and ring roads per block (OpenCity alignment maps, public domain).

Alignments on data.opencity.in:

    bengaluru   Greater Bengaluru Authority's eleven elevated corridors (August 2026 list, categories A to C, tender
                floated or under way), one centreline each
    pune        MSRDC's Pune Outer Ring Road, western alignment and eastern parts 1 and 2 (EIA alignment maps);
                the western map's chainage ticks (two-point lines) are dropped. Most of it runs outside the Pune
                map's bounding box, so the default bake is Bengaluru only

Per L7 block (dataset ``new_roads``):

    newroad_dist_m   distance from the block centre to the nearest planned alignment (blocks within 3 km)
    newroad_len_m    alignment length inside the block
    newroad_kind     1 elevated corridor, 2 ring road (nearest alignment)
    newroad_ref      1-based index of the nearest alignment in ``ALIGNMENTS[region]`` (named in the dataset description)

    python -m pipeline.realestate.newroads [--region bengaluru]
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from pipeline.realestate.bdalayouts import region_cells
from pipeline.realestate.drainbuffers import lines
from pipeline.realestate.sewers import pieces

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
NEAR_M = 3000
STEP_M = 20
EC, RR = 1, 2
ALIGNMENTS = {     # region: [(name, kind, OpenCity dataset, resource name)]
    "bengaluru": [
        ("Marenahalli to Kanakapura Main Road elevated corridor (18.5 km)", EC, "elevated-corridor-from-ragigudda-to-kanakapura-road-nice-road-junction-documents", "Coordinates"),
        ("Yeshwanthapura to Old Madras Road elevated corridor (28 km)", EC, "elevated-corridor-from-yeshwantpur-to-kr-puram", "Coordinates"),
        ("Old Madras Road to Silk Board elevated corridor (5.2 km)", EC, "elevated-corridor-from-old-madras-road-to-central-silk-board-documents", "Coordinates"),
        ("Sholay Circle to St. John's Hospital elevated corridor (5.3 km)", EC, "documents-elevated-corridor-at-adugodi", "Coordinates"),
        ("Sirsi Circle to Nayandahalli elevated corridor (5.2 km)", EC, "elevated-corridor-on-mysore-road", "Coordinates"),
        ("Minerva Circle to Hudson Circle elevated corridor (7 km)", EC, "hudson-circle-flyover", "Coordinates"),
        ("Ananda Bhavan to Raghuvanahalli elevated corridor (0.9 km)", EC, "documents-elevated-corridor-at-adyar-ananda-bhavan-raghuvanahalli-cross", "Coordinates"),
        ("Konanakunte Cross elevated corridor (1.5 km)", EC, "documents-elevated-corridor-at-konanakunte", "Coordinates"),
        ("Doddaballapura Road to NH-7 elevated corridor (1.5 km)", EC, "documents-elevated-corridor-at-yelahanka", "Coordinates"),
        ("West of Chord Road to Outer Ring Road elevated corridor (2 km)", EC, "documents-elevated-corridor-at-pipeline-road", "Coordinates"),
        ("MEI Junction elevated corridor (0.5 km)", EC, "documents-elevated-corridor-at-mei-junction", "Coordinates"),
    ],
    "pune": [
        ("Pune Outer Ring Road, western alignment", RR, "pune-outer-ring-road-documents", "Western Alignment Map"),
        ("Pune Outer Ring Road, eastern alignment part 1", RR, "pune-outer-ring-road-documents", "Eastern Part 1 Alignment Map"),
        ("Pune Outer Ring Road, eastern alignment part 2", RR, "pune-outer-ring-road-documents", "Eastern Part 2 Alignment Map"),
    ],
}


WHO = {"bengaluru": "Greater Bengaluru Authority's elevated corridors, August 2026 list, tenders floated",
       "pune": "MSRDC's Pune Outer Ring Road, EIA alignment maps"}


def resource_url(package, name):
    import requests
    p = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": package}, timeout=60).json()["result"]
    return next(r["url"] for r in p["resources"] if r["name"].startswith(name) and r["format"] == "KML")


def alignment(text):
    """Centreline polylines of one KML; two-point lines (chainage ticks) are dropped when longer lines exist."""
    ls = list(lines(text))
    long = [pts for pts in ls if len(pts) > 2]
    return long or ls


def dedupe(polylines, near_m=150):
    """Drop lines that run alongside a longer kept one (right-of-way edges drawn next to the centreline)."""
    import numpy as np
    from scipy.spatial import cKDTree
    kept, pts = [], []
    for pl in sorted(polylines, key=lambda p: -sum(m for *_, m in pieces(p))):
        s = np.array([(lng * 106000, lat * 110540) for lat, lng in densify([pl])])
        if pts and (cKDTree(np.array(pts)).query(s)[0] < near_m).mean() > 0.8:
            continue
        kept.append(pl)
        pts += s.tolist()
    return kept


def densify(polylines, step_m=STEP_M):
    """(lat, lng) samples every ~step_m along the polylines."""
    out = []
    for pts in polylines:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            d = math.hypot((x1 - x0) * 111320 * math.cos(math.radians(y0)), (y1 - y0) * 110540)
            k = max(1, int(d // step_m))
            out += [(y0 + (y1 - y0) * i / k, x0 + (x1 - x0) * i / k) for i in range(k)]
        out.append((pts[-1][1], pts[-1][0]))
    return out


def nearest(cells, roads):
    """{code: (dist_m, ref)} for blocks within NEAR_M of any alignment. cells: [(code, lat, lng)]; roads: [(ref, [(lat, lng)])]."""
    import numpy as np
    from scipy.spatial import cKDTree
    if not cells or not roads:
        return {}
    lat0 = sum(c[1] for c in cells) / len(cells)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    pts, refs = [], []
    for ref, samples in roads:
        pts += [(lng * kx, lat * ky) for lat, lng in samples]
        refs += [ref] * len(samples)
    d, i = cKDTree(np.array(pts)).query(np.array([(lng * kx, lat * ky) for _, lat, lng in cells]), distance_upper_bound=NEAR_M)
    return {c[0]: (float(d[j]), refs[i[j]]) for j, c in enumerate(cells) if math.isfinite(d[j])}


def records(cells, polys_by_ref, kinds):
    near = nearest(cells, [(ref, densify(p)) for ref, p in polys_by_ref.items()])
    recs = [{"digipin": c, "newroad_dist_m": round(d), "newroad_ref": ref, "newroad_kind": kinds[ref]} for c, (d, ref) in near.items()]
    for polys in polys_by_ref.values():
        for pts in polys:
            recs += [{"lat": lat, "lng": lng, "newroad_len_m": m} for lat, lng, m in pieces(pts)]
    return recs


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    names = "; ".join(f"{i + 1} {a[0]}" for i, a in enumerate(ALIGNMENTS[region]))
    specs = [
        FieldSpec("newroad_dist_m", "Distance to the nearest planned elevated corridor or ring road", agg="min", unit="m", domain=[0, NEAR_M], ramp="viridis", higher_is=None),
        FieldSpec("newroad_len_m", "Planned alignment length in the block", agg="sum", unit="m", ramp="reds", higher_is=None),
        FieldSpec("newroad_kind", "Nearest planned road: 1 elevated corridor, 2 ring road", agg="min", domain=[1, 2], ramp="viridis", higher_is=None),
        FieldSpec("newroad_ref", "Nearest planned road (number in the description)", agg="min", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="new_roads", title="Big roads to come (elevated corridors and ring roads)", level=LEVEL, fields=specs, group="Mobility",
        description=f"Planned road alignments published on data.opencity.in ({WHO[region]}). Distance from each block within "
                    f"{NEAR_M // 1000} km to the nearest alignment and the alignment length inside it. Roads: {names}.",
        source="pipeline/realestate/newroads.py (OpenCity alignment maps)",
        license="Public domain (GBA and MSRDC via data.opencity.in)", default_field="newroad_dist_m", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def fetch(region):
    import requests
    polys, kinds = {}, {}
    for ref, (name, kind, pkg, res) in enumerate(ALIGNMENTS[region], 1):
        polys[ref] = dedupe(alignment(requests.get(resource_url(pkg, res), timeout=600).content.decode("utf-8-sig")))
        kinds[ref] = kind
        km = sum(m for pts in polys[ref] for _, _, m in pieces(pts)) / 1000
        print(f"{region}: {name}: {len(polys[ref])} lines, {km:.1f} km")
    return polys, kinds


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="bengaluru")
    a = ap.parse_args(argv)
    for region in a.region.split(","):
        polys, kinds = fetch(region)
        info = cell_dataset(region, records(region_cells(region), polys, kinds))
        print(f"{region}: {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
