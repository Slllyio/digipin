"""Sub-registrar office (SRO) per block from the state registration departments' jurisdiction maps (OpenCity, public
domain).

Per L7 block (dataset ``registration``):

    sro        the sub-registrar office whose jurisdiction holds the block centre: where a property here is registered
    sro_id     its official code (Karnataka SRO_Code, Tamil Nadu sro_id), a number the lenses can group by
    dro        the district registrar office above it
    sro_km     straight-line distance from the block to that office, km
    offices    registration offices (SRO or DRO) standing in the block

Maps: Karnataka Stamps and Registration's Bengaluru Urban SRO jurisdictions (50) and office locations (KGIS), and Tamil
Nadu Registration's SRO jurisdictions (697 across the state) and office locations (699, TNGIS). Office points are
matched to jurisdictions by name.

    python -m pipeline.realestate.registration --region bengaluru,chennai
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
KA = OPENCITY + "a7559614-4e2c-4462-a2f0-740135fe5616/resource/"
TN = OPENCITY + "6482c9a0-0323-4020-9687-50d18cc0f62d/resource/"
SOURCES = {
    "bengaluru": (KA + "1405a12a-839f-4ee2-a61b-03dc699b1061/download/994e6b83-8145-495d-ab7e-2f50b4560b93.kml",
                  KA + "8dd1bb99-e9a4-4b5c-b01e-520b46fd766e/download/89a0feea-a927-4e1a-b517-32d96a7e2670.kml"),
    "chennai": (TN + "fb23f58d-55bc-4d1b-b333-6860743d0363/download/tn_sro_boundaries.geojson",
                TN + "d55430ba-87c9-41f4-8789-740f8b729b03/download/tn_registration_offices.geojson"),
}


MATCH_KM = 30


def norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def title(s):
    return " ".join(w.capitalize() for w in re.sub(r"[_\s]+", " ", s or "").strip().split()) or None


def jurisdictions(region, text):
    """[(sro, dro, geometry, sro_id)] from the state's jurisdiction map."""
    from pipeline.realestate.wards import kml_features
    if region == "bengaluru":
        return [(title(f["properties"].get("SRO_Name")), title(f["properties"].get("DRO_Name")), f["geometry"], code(f["properties"].get("SRO_Code")))
                for f in kml_features(text)]
    return [(title(f["properties"].get("sro_name")), title(f["properties"].get("dro_name")), f["geometry"], code(f["properties"].get("sro_id")))
            for f in json.loads(text)["features"] if f.get("geometry")]


def code(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def offices(region, text):
    """{normalised name: [(lng, lat), ...]} of registration offices (a name can repeat across a state)."""
    from pipeline.realestate.toilets import kml_points
    out = {}
    if region == "bengaluru":
        for x, y, p in kml_points(text):
            out.setdefault(norm(p.get("SROName")), []).append((x, y))
        return out
    for f in json.loads(text)["features"]:
        g, p = f.get("geometry") or {}, f.get("properties") or {}
        if g.get("type") == "Point":
            out.setdefault(norm(p.get("office_name") or p.get("name")), []).append(tuple(g["coordinates"][:2]))
    return out


def km(a, b):
    k = 111.32
    return math.hypot((a[0] - b[0]) * k * math.cos(math.radians((a[1] + b[1]) / 2)), (a[1] - b[1]) * k)


def assign(cells, juris):
    """{code: index into juris} for block centres inside a jurisdiction (DuckDB spatial)."""
    import duckdb

    from pipeline.realestate.wards import closed
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
    for k, j in enumerate(juris):
        g = closed(j[2])
        if not g:
            continue
        try:   # a few state polygons make MakeValid fail ("mixed-dimension"); those go in as drawn
            con.execute("INSERT INTO w VALUES (?, ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON(?)), 3))", [k, json.dumps(g)])
        except duckdb.Error:
            con.execute("INSERT INTO w VALUES (?, ST_GeomFromGeoJSON(?))", [k, json.dumps(g)])
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", cells)
    return dict(con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(w.geom, ST_Point(c.x, c.y)) GROUP BY 1").fetchall())


def rows(cells, juris, office):
    centre = {c: (x, y) for c, y, x in cells}
    out = {}
    for code, k in assign(cells, juris).items():
        sro, dro, _, sid = juris[k]
        r = {"sro": sro, "dro": dro, "sro_id": sid}
        d = min((km(centre[code], at) for at in office.get(norm(sro), ())), default=None)
        if d is not None and d <= MATCH_KM:   # farther means the name matched another district's office
            r["sro_km"] = round(d, 2)
        out[code] = {a: b for a, b in r.items() if b is not None}
    return out


def cell_dataset(region, rows_, office_pts):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("sro", "Sub-registrar office (property registration)", type="category", agg="mode"),
        FieldSpec("dro", "District registrar office", type="category", agg="mode"),
        FieldSpec("sro_id", "Sub-registrar office code", agg="max", unit="", ramp="viridis", higher_is="better"),
        FieldSpec("sro_km", "Distance to the block's sub-registrar office", agg="mean", unit="km", ramp="reds", higher_is="worse"),
        FieldSpec("offices", "Registration offices in the block", agg="sum", unit="offices", ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="registration", title="Sub-registrar offices (registration jurisdictions)", level=LEVEL, fields=specs, group="Real estate",
        description="The sub-registrar office whose jurisdiction holds each lived-in block (where property there is registered and "
                    "whose guidance values apply), its district registrar office and the distance to the office, from Karnataka "
                    "Stamps and Registration (Bengaluru Urban) and Tamil Nadu Registration (Chennai) maps on data.opencity.in.",
        source="pipeline/realestate/registration.py (OpenCity SRO jurisdiction and office maps via DuckDB spatial)",
        license="Public domain (Karnataka Stamps and Registration, Tamil Nadu Registration via data.opencity.in)", default_field="sro", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()] + [{"lng": x, "lat": y, "offices": 1} for x, y in office_pts]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        get = lambda u: requests.get(u, timeout=600).content.decode("utf-8-sig")
        juris_url, office_url = SOURCES[r]
        juris, office = jurisdictions(r, get(juris_url)), offices(r, get(office_url))
        w, s, e, n = bbox_for(r)
        pts = [p for p in {q for v in office.values() for q in v} if w <= p[0] <= e and s <= p[1] <= n]
        got = rows(lived_cells(r), juris, office)
        info = cell_dataset(r, got, pts)
        print(f"{r}: {len({v.get('sro') for v in got.values()})} SROs over {len(got)} blocks, {len(pts)} offices, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
