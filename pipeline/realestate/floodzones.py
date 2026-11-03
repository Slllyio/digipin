"""Official flood hazard zones and return-period flood extents per block for Chennai (OpenCity, public domain).

Per L7 block (dataset ``flood_zones``), each a share of the block's ground, %:

    hazard_vhigh_pct   in the Very High flood inundation hazard zone
    hazard_high_pct    in the High zone
    hazard_mod_pct     in the Moderate zone
    hazard_index       mean hazard class over the mapped ground (1 very low to 5 very high)
    rp5_pct ... rp200_pct  inside the modelled flood extent of the 5, 10, 25, 50, 100 and 200-year return period flows
    rp100_deep_pct     inside the 100-year extent's HIGH class
    flood_rp_years     the most frequent return period whose extent covers at least a quarter of the block (none: not
                       flooded even in the 200-year flow)

Maps: the Chennai flood inundation hazard zones (7,453 polygons in five classes) and the modelled flood extents for six
return periods (each in LOW, MODERATE and HIGH classes), published as KML on data.opencity.in. Each block is sampled on a
6 x 6 grid of points (DuckDB spatial), as for the land use maps.

    python -m pipeline.realestate.floodzones
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RPS = (5, 10, 25, 50, 100, 200)
CLASSES = {"very high": 5, "high": 4, "moderate": 3, "low": 2, "very low": 1}
PLACEMARK = re.compile(r"<Placemark\b[^>]*>(.*?)</Placemark>", re.S)
CATEGORY = re.compile(r'<SimpleData name="CATEGORY">([^<]*)<')
RP_NAME = re.compile(r"Flows (\d+) Years? Return Period", re.I)


def urls():
    """{'hazard': url, 5: url, ...} from the OpenCity package listing."""
    import requests
    res = requests.get("https://data.opencity.in/api/3/action/package_show?id=chennai-flooding-data", timeout=60).json()["result"]["resources"]
    out = {}
    for r in res:
        m = RP_NAME.search(r.get("name") or "")
        if m:
            out[int(m.group(1))] = r["url"]
        elif "hazard" in (r.get("name") or "").lower():
            out["hazard"] = r["url"]
    return out


def polygons(text):
    """(category lower-case, GeoJSON MultiPolygon) per placemark."""
    from pipeline.realestate.landuse2017 import INNER, OUTER, POLY, ring
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        cat = CATEGORY.search(body)
        polys = []
        for pg in POLY.finditer(body):
            o = OUTER.search(pg.group(1))
            if o:
                rings = [ring(o.group(1))] + [ring(h) for h in INNER.findall(pg.group(1))]
                rings = [r + ([r[0]] if r and r[0] != r[-1] else []) for r in rings]
                if len(rings[0]) >= 4:
                    polys.append([r for r in rings if len(r) >= 4])
        if polys and cat:
            yield cat.group(1).strip().lower(), {"type": "MultiPolygon", "coordinates": polys}


def hazard_rows(cells, polys):
    from pipeline.realestate.landuse2017 import shares
    got = shares(cells, [(str(CLASSES[c]), g) for c, g in polys if c in CLASSES])
    out = {}
    for code, s in got.items():
        p = {k: s.get(f"{k}_pct", 0) for k in ("5", "4", "3", "2", "1")}
        mapped = sum(p.values())
        out[code] = {"hazard_vhigh_pct": round(p["5"], 1), "hazard_high_pct": round(p["4"], 1), "hazard_mod_pct": round(p["3"], 1),
                     "hazard_index": round(sum(int(k) * v for k, v in p.items()) / mapped, 2) if mapped else None}
    return out


def return_rows(cells, per_rp):
    """{code: {rpN_pct, rp100_deep_pct, flood_rp_years}} from {rp: [(category, geom)]}."""
    from pipeline.realestate.landuse2017 import shares
    out = {c: {} for c in cells}
    for rp, polys in per_rp.items():
        for code, s in shares(cells, [("x", g) for _, g in polys]).items():
            out[code][f"rp{rp}_pct"] = round(s["x_pct"], 1)
        if rp == 100:
            for code, s in shares(cells, [("x", g) for c, g in polys if c == "high"]).items():
                out[code]["rp100_deep_pct"] = round(s["x_pct"], 1)
    for code, r in out.items():
        hit = [rp for rp in sorted(per_rp) if r.get(f"rp{rp}_pct", 0) >= 25]
        if hit:
            r["flood_rp_years"] = hit[0]
    return {c: r for c, r in out.items() if r}


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pct = lambda k, label: FieldSpec(k, label, agg="mean", unit="%", domain=[0, 100], ramp="blues", higher_is="worse")
    specs = [
        pct("hazard_vhigh_pct", "Very High flood hazard zone"), pct("hazard_high_pct", "High flood hazard zone"),
        pct("hazard_mod_pct", "Moderate flood hazard zone"),
        FieldSpec("hazard_index", "Mean flood hazard class (1 very low to 5 very high)", agg="mean", unit="class", domain=[1, 5], ramp="blues", higher_is="worse"),
        *[pct(f"rp{rp}_pct", f"Inside the {rp}-year flood extent") for rp in RPS],
        pct("rp100_deep_pct", "Inside the 100-year flood extent's high class"),
        FieldSpec("flood_rp_years", "Most frequent flood (return period) covering a quarter of the block", agg="min", unit="years", domain=[5, 200], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="flood_zones", title="Official flood hazard zones and return periods (Chennai)", level=LEVEL, fields=specs, group="Real estate",
        description="Share of each block in Chennai's five flood inundation hazard classes and inside the modelled flood extents "
                    "of the 5, 10, 25, 50, 100 and 200-year return period flows, from the Chennai flooding maps on data.opencity.in.",
        source="pipeline/realestate/floodzones.py (OpenCity Chennai flood hazard zones and return-period flows via DuckDB spatial)",
        license="Public domain (via data.opencity.in)", default_field="flood_rp_years", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import os
    import tempfile

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.bdalayouts import region_cells
    from pipeline.realestate.sewers import download
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    w, s, e, n = bbox_for("chennai")
    cells = [c for c, lat, lng in region_cells("chennai") if w <= lng <= e and s <= lat <= n]
    src = urls()
    texts = {}
    with tempfile.TemporaryDirectory() as tmp:
        for key, url in src.items():
            local = os.path.join(a.from_dir or tmp, url.rsplit("/", 1)[-1])
            if not os.path.exists(local):
                download(url, local)
            texts[key] = open(local, encoding="utf-8-sig").read()
    rows_ = hazard_rows(cells, list(polygons(texts.pop("hazard"))))
    for code, r in return_rows(cells, {rp: list(polygons(t)) for rp, t in texts.items()}).items():
        rows_.setdefault(code, {}).update(r)
    info = cell_dataset("chennai", rows_)
    print(f"chennai: {len(cells)} blocks sampled, return periods {sorted(texts)}, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
