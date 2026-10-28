"""Electricity and water service areas per block, and how many of them each ward deals with (OpenCity, public domain).

Per L7 block (dataset ``service_areas``):

    power_unit        the electricity section office area holding the block centre (BESCOM section code; TNEB section
                      number in the map)
    power_name        its name (BESCOM)
    water_unit        the water utility's field unit holding the block (BWSSB service station; CMWSSB depot)
    water_name        its name (BWSSB)
    ward_power_units  electricity sections that cover some lived-in part of the block's ward
    ward_water_units  water field units that cover some lived-in part of the block's ward
    ward_police_units police stations that cover some lived-in part of the block's ward (where mapped)
    ward_id           a number per ward (by name), so lenses can tell wards apart

Maps: BESCOM section boundaries (237) and BWSSB service station boundaries (143) for Bengaluru; TNEB section boundaries
(2,914 across Tamil Nadu) and CMWSSB depot boundaries (199) for Chennai. Wards come from the ``wards`` dataset and
police stations from ``police_stations``. When boundaries line up a ward deals with one or two units of each agency;
the more units, the more offices a ward's residents and councillor must chase for one street's problems.

    python -m pipeline.realestate.serviceareas --region bengaluru,chennai
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
O = "https://data.opencity.in/dataset/"
SOURCES = {
    "bengaluru": {
        "power": O + "095be44d-3f74-4e5d-b06e-304a14716cff/resource/45defb41-2938-4a69-869b-ab10c8559bc4/download/1de97d97-8334-4fdc-9778-262df0bd8fef.kml",
        "water": O + "52a5d05b-0b8a-4511-a9b0-9123ad9c0113/resource/7bdecf91-fa6e-4269-acab-ac91e7b4648c/download/c546c18b-6d9a-460b-88a1-41fb329bc9de.kml",
    },
    "chennai": {
        "power": O + "d310e8f5-8f93-4e72-9a66-7c8d67101995/resource/1013399c-fd78-43d9-a39c-9a6bd7327ca1/download/tneb_section_boundary.kml",
        "water": O + "c02001d0-0955-4a76-a1ec-7aadf173166e/resource/4743455b-bbe0-4fa3-8457-35a4179fbda1/download/c3d841b0-eeec-49e9-a9cf-4f10c84e329b.kml",
    },
}


def title(s):
    s = " ".join((s or "").split())
    return " ".join(w.capitalize() for w in s.split()) if s.isupper() else (s or None)


def units(kind, text):
    """[(unit number, name or None, geometry)] from a utility boundary map; unnamed features are numbered in order."""
    from pipeline.realestate.wards import kml_features
    out = []
    for k, f in enumerate(kml_features(text), start=1):
        p = f["properties"]
        if kind == "power":
            code, name = p.get("SectionCode"), title(p.get("SectionName"))
        else:
            code, name = p.get("depot") or p.get("KGISService_StationID"), title(p.get("Service_StationName"))
        try:
            num = int(float(code))
        except (TypeError, ValueError):
            num = k
        out.append((num, name, f["geometry"]))
    return out


def read_column(region, dataset, field):
    """{code: value} of one field of a baked dataset for a region, or {} when it is not baked there."""
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    d = next((x for x in cat["datasets"] if x["id"] == dataset), None)
    entry = next((r for r in (d or {}).get("regions", []) if r["name"] == region), None)
    if not entry:
        return {}
    t = store.read_region(CELLS, entry)
    col = t.columns.get(field)
    return {c: v for c, v in zip(t.codes, col) if v not in (None, "")} if col is not None else {}


def ward_counts(rows_, ward, police):
    """Per block, how many distinct power units, water units and police stations its ward's lived-in blocks touch."""
    seen = {}
    for c, r in rows_.items():
        w = ward.get(c)
        if w is None:
            continue
        s = seen.setdefault(w, (set(), set(), set()))
        if "power_unit" in r:
            s[0].add(r["power_unit"])
        if "water_unit" in r:
            s[1].add(r["water_unit"])
        if c in police:
            s[2].add(police[c])
    ids = {w: k + 1 for k, w in enumerate(sorted(seen))}
    for c, r in rows_.items():
        s = seen.get(ward.get(c))
        if s:
            r["ward_id"] = ids[ward[c]]
            r["ward_power_units"], r["ward_water_units"] = len(s[0]), len(s[1])
            if police:
                r["ward_police_units"] = len(s[2])
    return rows_


def rows(cells, power, water):
    from pipeline.realestate.registration import assign
    out = {}
    for key, us in (("power", power), ("water", water)):
        for c, k in assign(cells, [(None, None, u[2]) for u in us]).items():
            r = out.setdefault(c, {})
            r[f"{key}_unit"] = us[k][0]
            if us[k][1]:
                r[f"{key}_name"] = us[k][1]
    return out


def cell_dataset(region, rows_):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("power_unit", "Electricity section (number)", agg="max", unit="", ramp="viridis", higher_is="better"),
        FieldSpec("power_name", "Electricity section office", type="category", agg="mode"),
        FieldSpec("water_unit", "Water utility field unit (number)", agg="max", unit="", ramp="viridis", higher_is="better"),
        FieldSpec("water_name", "Water utility service station", type="category", agg="mode"),
        FieldSpec("ward_power_units", "Electricity sections the ward deals with", agg="max", unit="units", ramp="reds", higher_is="worse"),
        FieldSpec("ward_water_units", "Water field units the ward deals with", agg="max", unit="units", ramp="reds", higher_is="worse"),
        FieldSpec("ward_police_units", "Police stations the ward deals with", agg="max", unit="units", ramp="reds", higher_is="worse"),
        FieldSpec("ward_id", "Ward number (within the city, by name)", agg="max", unit="", ramp="viridis", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="service_areas", title="Electricity and water service areas", level=LEVEL, fields=specs, group="Real estate",
        description="The electricity section and water field unit serving each lived-in block (BESCOM and BWSSB for Bengaluru, "
                    "TNEB and CMWSSB for Chennai) and how many of each, and of police stations, the block's ward deals with, "
                    "from the utilities' boundary maps on data.opencity.in.",
        source="pipeline/realestate/serviceareas.py (OpenCity BESCOM, BWSSB, TNEB and CMWSSB boundary maps via DuckDB spatial)",
        license="Public domain (BESCOM, BWSSB, TNEB and CMWSSB via data.opencity.in)", default_field="ward_power_units", extrude=False)
    recs = [{"digipin": c, **r} for c, r in rows_.items()]
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import os

    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.pincodes import bounds
    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(SOURCES))
    ap.add_argument("--from-dir", help="read the maps (named as in the URLs) from this folder instead of downloading")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        got = {}
        w, s, e, n = bbox_for(r)
        for kind, url in SOURCES[r].items():
            local = os.path.join(a.from_dir, url.rsplit("/", 1)[-1]) if a.from_dir else None
            text = open(local, encoding="utf-8-sig").read() if local and os.path.exists(local) else requests.get(url, timeout=600).content.decode("utf-8-sig")
            us = [u for u in units(kind, text) if (lambda b: b[0] <= e and b[2] >= w and b[1] <= n and b[3] >= s)(bounds(u[2]))]
            got[kind] = us
        rows_ = ward_counts(rows(lived_cells(r), got["power"], got["water"]), read_column(r, "wards", "ward"), read_column(r, "police_stations", "station"))
        info = cell_dataset(r, rows_)
        print(f"{r}: {len(got['power'])} power units, {len(got['water'])} water units, {len(rows_)} blocks, {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
