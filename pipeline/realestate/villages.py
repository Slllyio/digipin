"""Revenue village per block from Survey of India's village maps (OpenCity, public domain).

Per L7 block (dataset ``villages``):

    village      the revenue village whose boundary holds the block centre: the name land records (RTC, 7/12 extract,
                 khasra, jamabandi) are filed under
    tehsil       its tehsil or taluk
    district     its district
    village_id   a number per village within the city (by name), for grouping
    village_km2  area of the whole village, km2
    in_town      1 where the map draws a town, municipal or cantonment limit instead of villages (old BBMP core and the
                 former city municipalities in Bengaluru, Pune's "Urban" core, south Kolkata's "suburbs", the Delhi and
                 Ahmedabad cantonments); land there is on the city survey, not a village's

Maps: Survey of India village boundaries for Bengaluru Urban (702), Pune district (1,922), Ahmedabad district (559),
south Kolkata (70) and Delhi's eleven districts (2022). Only lived-in blocks (with a population estimate) are kept.

    python -m pipeline.realestate.villages --region delhi,bengaluru,pune,ahmedabad,kolkata
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from pipeline.realestate.pincodes import area_km2, bounds

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
V = "https://data.opencity.in/dataset/0453ba92-ca98-4097-9aef-a91c9343efb0/resource/"
D = "https://data.opencity.in/dataset/8d82fabb-7fd9-45ad-a36a-4e0aa983e4c6/resource/"
SOURCES = {
    "bengaluru": [V + "d7cdff8d-404f-4917-bf2d-f27695a58659/download/c1f53e08-80bf-4069-857a-b0cd1a6e2599.kml"],
    "pune": [V + "327ecf67-dd7c-4e2d-bf80-6fe6a1b5947a/download/c9aa6627-644c-4bb3-99be-2a1b86efb35b.kml"],
    "ahmedabad": [V + "e5359634-25e3-4e9a-9bfe-bc7f9ad68f93/download/8366aa7e-1b71-4782-98bb-4fd7194c410d.kml"],
    "kolkata": [V + "8f164042-e946-4dd9-aed6-49ab200f767f/download/fda8bce7-4444-44c9-824e-be13c99f50dc.kml"],
    "delhi": [D + p for p in (
        "7111e9ea-d775-4dde-a490-568149ac21da/download/91beef33-15c7-49fb-bbd9-6d8674aa9925.kml",
        "dc8f0f39-3962-497f-bd20-27fd0321b5c4/download/5218a752-eef0-4b9e-8c9a-7be3030b9e09.kml",
        "62568cdb-d4d1-41a2-bf5c-e63133c51aa6/download/47544153-75d8-414c-b325-2fb1655b5fa8.kml",
        "7fddacae-eef8-4aba-87fc-a03e677c6b33/download/55b176c4-d63e-4042-9c6c-4bff8c95c19d.kml",
        "adda2ffc-6184-4968-92c8-dd29ffe14ce6/download/761404dc-e82f-45a7-9982-0f68999161fd.kml",
        "e1558669-cb5f-4635-b2f3-e1f80158204e/download/f7c38f9e-ea9d-4c05-9259-0c441856f313.kml",
        "e6932bf6-1384-45ae-989b-5bf96ac2c935/download/64ebd13e-03f4-4f87-9fd1-560909f3c972.kml",
        "48036dc4-c97b-43d7-9cdf-9357ef406880/download/d1741464-1179-4cff-9a19-3011642530a4.kml",
        "012bd600-91b3-4add-825b-84a681f7a8e0/download/5688fd69-e1ec-4d54-8a33-e69c391dff51.kml",
        "af30bcc3-ad19-4e02-ae27-952875e28ee0/download/8f08bea2-e1e7-4862-af77-fd2aed6703d6.kml",
        "d5866302-fc55-48cb-9dd3-ef5196371591/download/8bca4be6-bf44-4545-942b-5ebdc9dd0e3e.kml")],
}
TOWN = re.compile(r"corporation|\(m\)|cantonment|chhawni|munc?ipal|suburbs of|\(urban\)|^urban$|^(bangalore|bengaluru|pune|ahmedabad|kolkata|delhi)$", re.I)


def title(s):
    s = " ".join((s or "").split())
    return " ".join(w.capitalize() for w in s.split()) if s.isupper() else (s or None)


def villages(text):
    """[(village, tehsil, district, geometry, km2, bounds, town)] from a Survey of India village map."""
    from pipeline.realestate.wards import kml_features
    out = []
    for f in kml_features(text):
        p, g = f["properties"], f["geometry"]
        name = title(p.get("VILLAGE") or p.get("VillageNam"))
        if not name:
            continue
        out.append((name, title(p.get("TEHSIL")), title(p.get("DISTRICT")), g, round(area_km2(g), 2), bounds(g), bool(TOWN.search(name))))
    return out


def rows(cells, vills):
    from pipeline.realestate.registration import assign
    got = assign(cells, [(None, None, v[3]) for v in vills])
    ids = {n: k + 1 for k, n in enumerate(sorted({v[0] for v in vills if not v[6]}))}
    out = {}
    for c, k in got.items():
        name, tehsil, district, _, km2, _, town = vills[k]
        r = {"tehsil": tehsil, "district": district}
        if town:
            r["in_town"] = 1
        else:
            r.update(village=name, village_id=ids[name], village_km2=km2)
        out[c] = {a: b for a, b in r.items() if b is not None}
    return out


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("village", "Revenue village (land records)", type="category", agg="mode"),
        FieldSpec("tehsil", "Tehsil or taluk", type="category", agg="mode"),
        FieldSpec("district", "District", type="category", agg="mode"),
        FieldSpec("village_id", "Revenue village number (within the city)", agg="max", unit="", ramp="viridis", higher_is="better"),
        FieldSpec("village_km2", "Area of the block's revenue village", agg="mean", unit="km2", ramp="viridis", higher_is="better"),
        FieldSpec("in_town", "Inside a municipal or cantonment limit on the village map", agg="max", unit="", domain=[0, 1], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="villages", title="Revenue villages (Survey of India maps)", level=LEVEL, fields=specs, group="Real estate",
        description="The revenue village, tehsil and district whose Survey of India boundary holds each lived-in block (the names "
                    "land records are filed under), from the village maps for Delhi, Bengaluru Urban, Pune, Ahmedabad and south "
                    "Kolkata on data.opencity.in.",
        source="pipeline/realestate/villages.py (OpenCity Survey of India village maps via DuckDB spatial)",
        license="Public domain (Survey of India via data.opencity.in)", default_field="village_id", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import os
    import tempfile

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.powerplants import lived_cells
    from pipeline.realestate.sewers import download, read_kml
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        vills = []
        with tempfile.TemporaryDirectory() as tmp:
            for url in SOURCES[r]:
                src = os.path.join(a.from_dir or tmp, url.rsplit("/", 1)[-1])
                if not os.path.exists(src):
                    download(url, src)
                vills += villages(read_kml(src))
        w, s, e, n = bbox_for(r)
        vills = [v for v in vills if v[5][0] <= e and v[5][2] >= w and v[5][1] <= n and v[5][3] >= s]
        got = rows(lived_cells(r), vills)
        info = cell_dataset(r, got)
        town = sum(1 for v in got.values() if v.get("in_town"))
        print(f"{r}: {len({v['village'] for v in got.values() if 'village' in v})} villages over {len(got) - town} blocks, "
              f"{town} blocks in a town limit, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
