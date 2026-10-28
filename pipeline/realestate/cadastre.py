"""Land parcel grain and public land per block from the official cadastral maps (OpenCity, public domain).

Per L7 block (dataset ``cadastre``):

    parcels       survey parcels whose centre falls in the block
    parcel_m2     median area of those parcels, m2
    public_pct    share of the block's ground in government land (Hyderabad: parcels marked government, department,
                  graveyard or GHMC) or in revenue kharab land (Bengaluru: streams, tanks, roads, canals, rail and
                  rivers), %

Maps: Hyderabad's GHMC town survey map (147,000 parcels with a government / private flag), Bengaluru's BBMP-area
revenue survey map (KGIS, 35,000 survey numbers and kharab strips) and Pune's PMC revenue map (29,000 gut numbers).
Hyderabad's parcels are town survey plots; Bengaluru's and Pune's are the revenue survey numbers that farms were
recorded on before the city grew over them, so their size says how many owners a land assembly must deal with.

    python -m pipeline.realestate.cadastre --region hyderabad,bengaluru,pune
"""
from __future__ import annotations

import argparse
import math
import re
import statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
O = "https://data.opencity.in/dataset/"
SOURCES = {
    "hyderabad": O + "2b1619fe-7b9f-4a8c-8140-541e98d1a9b6/resource/9ea0e221-8bc5-4aff-8b29-3e57063026d2/download/hyd_cadastral_geojson.zip",
    "bengaluru": O + "b5d91825-a104-41c8-bf93-3aedcfd58124/resource/9e7761c4-b39b-4124-af70-f73303e3ee6b/download/1e75032d-830a-4581-ada4-4e47a97faf87.kml",
    "pune": O + "b0d8b534-c6ce-450d-9ef1-2e13d415efaf/resource/447d4d6a-905e-4bf4-aae9-afda709a222f/download/a76a14a9-07ce-4a36-bba5-8f8c12351c6b.kmz",
}
GOVT = re.compile(r"^(govt|dept|gryd|ghmc)", re.I)
KHARAB = {"stream", "tank", "road", "canal", "rail", "river"}
PLACEMARK = re.compile(r"<Placemark\b[^>]*>(.*?)</Placemark>", re.S)
DATA = re.compile(r'<SimpleData name="([\w.()]+)">([^<]*)<')


def ring_area_centre(ring):
    """(area m2, (lng, lat) vertex mean) of a lng/lat ring, on a local flat projection."""
    if len(ring) < 4:
        return 0.0, None
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    s = sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1))
    return abs(s) / 2 * kx * ky, (sum(p[0] for p in ring[:-1]) / (len(ring) - 1), sum(p[1] for p in ring[:-1]) / (len(ring) - 1))


def parcel(geom):
    """(area m2, (lng, lat)) of a GeoJSON polygon or multipolygon: outer rings summed, centre of the largest."""
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    best, total = (0.0, None), 0.0
    for poly in polys:
        a, c = ring_area_centre([tuple(p[:2]) for p in poly[0]])
        holes = sum(ring_area_centre([tuple(p[:2]) for p in h])[0] for h in poly[1:])
        total += a - holes
        if a > best[0]:
            best = (a, c)
    return total, best[1]


def hyderabad_features(text):
    """(is_public, geometry) per parcel from the GHMC town survey GeoJSON; LAYER 'Unknown Area Type' slivers dropped."""
    import json
    for f in json.loads(text)["features"]:
        p = f["properties"]
        if (p.get("LAYER") or "").strip() or not f.get("geometry"):
            continue
        yield bool(GOVT.match((p.get("GOVT") or "").strip())), f["geometry"]


def kml_features(text, kind):
    """(is_public, geometry) per placemark of the Bengaluru or Pune revenue map KML."""
    from pipeline.realestate.landuse2017 import INNER, OUTER, POLY, ring
    for m in PLACEMARK.finditer(text):
        body = m.group(1)
        p = dict(DATA.findall(body))
        public = kind == "bengaluru" and (p.get("Category") or "").strip().lower() in KHARAB
        polys = []
        for pg in POLY.finditer(body):
            o = OUTER.search(pg.group(1))
            if o:
                rings = [ring(o.group(1))] + [ring(h) for h in INNER.findall(pg.group(1))]
                rings = [r + ([r[0]] if r and r[0] != r[-1] else []) for r in rings]
                if len(rings[0]) >= 4:
                    polys.append([r for r in rings if len(r) >= 4])
        if polys:
            yield public, {"type": "MultiPolygon", "coordinates": polys}


def parcel_rows(features, strips=False):
    """{code: {parcels, parcel_m2}} from (is_public, geometry); with strips, public features (roads, streams) are not parcels."""
    from pipeline.cells.store import cell_code
    sizes = {}
    for public, g in features:
        if public and strips:
            continue
        a, c = parcel(g)
        if c and 20 <= a <= 2e6:
            code = cell_code(LEVEL, c[1], c[0])
            if code:
                sizes.setdefault(code, []).append(a)
    return {c: {"parcels": len(v), "parcel_m2": round(statistics.median(v))} for c, v in sizes.items()}


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("parcels", "Survey parcels (centre in the block)", agg="sum", unit="parcels", ramp="viridis", higher_is=None),
        FieldSpec("parcel_m2", "Median survey parcel size", agg="mean", unit="m2", domain=[100, 20000], ramp="viridis", higher_is=None),
        FieldSpec("public_pct", "Government or kharab (public) land", agg="mean", unit="%", domain=[0, 100], ramp="greens", higher_is=None),
    ]
    spec = DatasetSpec(
        id="cadastre", title="Survey parcels and public land (cadastral maps)", level=LEVEL, fields=specs, group="Real estate",
        description="Survey parcels per block, their median size and the share of the block in government or revenue kharab "
                    "land, from the GHMC town survey map (Hyderabad), the BBMP-area revenue survey map (Bengaluru, KGIS) and "
                    "the PMC revenue map (Pune) on data.opencity.in.",
        source="pipeline/realestate/cadastre.py (OpenCity Hyderabad, Bengaluru and Pune cadastral maps via DuckDB spatial)",
        license="Public domain (GHMC, Government of Karnataka and PMC via data.opencity.in)", default_field="parcel_m2", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def read_text(region, path):
    import zipfile
    if path.endswith((".zip", ".kmz")):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith((".geojson", ".kml")))
            return z.read(name).decode("utf-8-sig")
    return open(path, encoding="utf-8-sig").read()


def main(argv=None):
    import os
    import tempfile

    from pipeline.realestate.landuse2017 import shares
    from pipeline.realestate.sewers import download
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        url = SOURCES[r]
        with tempfile.TemporaryDirectory() as tmp:
            local = os.path.join(a.from_dir or tmp, url.rsplit("/", 1)[-1])
            if not os.path.exists(local):
                download(url, local)
            text = read_text(r, local)
        feats = list(hyderabad_features(text) if r == "hyderabad" else kml_features(text, r))
        del text
        rows_ = parcel_rows(feats, strips=r == "bengaluru")
        public = [("public", g) for p, g in feats if p]
        if public:
            for c, s in shares(list(rows_), public).items():
                rows_[c]["public_pct"] = round(s["public_pct"], 1)
            for c in rows_:
                rows_[c].setdefault("public_pct", 0.0)
        info = cell_dataset(r, rows_)
        print(f"{r}: {len(feats)} features ({len(public)} public), {len(rows_)} blocks with parcels, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
