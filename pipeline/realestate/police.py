"""Police stations from the state police maps (OpenCity, public domain).

Per L7 block (dataset ``police_official``):

    stations   police stations (law and order; offices, traffic chowkis and control rooms left out)
    outposts   police outposts (Bengaluru)
    in_area    1 where the city police's own jurisdiction map covers the block (Mumbai, Bengaluru): the lens judges
               reach only there, so Thane next to Mumbai is not read as a gap in Mumbai Police's map

Maps: Mumbai Police station locations (BMC disaster management GIS, 102 stations), Karnataka Police KGIS stations and
outposts for Bengaluru Urban, and Telangana Police stations for Hyderabad district plus the state map (UTM zone 44N, converted here) for the
Cyberabad and Rachakonda suburbs. Telangana lists police properties, so names are filtered to law-and-order stations.
OpenStreetMap misses many of these; the loader keeps whichever count is higher in ``places.police``.

    python -m pipeline.realestate.police --region mumbai,bengaluru,hyderabad
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

from pipeline.realestate.firestations import stations as dedupe
from pipeline.realestate.toilets import kml_points

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OPENCITY = "https://data.opencity.in/dataset/"
MUMBAI = OPENCITY + "62b0ed0b-4823-4419-99e9-6ab1670f6fdd/resource/8108052d-25fd-4f0d-a9f4-8b2cbc63f5a2/download/fbe6a2e1-64ee-459b-ab45-be1de84f603b.kml"
BLR_PS = OPENCITY + "1fe7e205-d00e-437e-b43d-6237f065dc2d/resource/b862cdc0-bf08-4706-9788-4f712d27f950/download/63a601fc-41a6-4e01-aad0-b053c67b392e.kml"
BLR_OP = OPENCITY + "1fe7e205-d00e-437e-b43d-6237f065dc2d/resource/59423322-eae5-4ee8-b7d5-db176d8077d8/download/74612016-6f67-4184-a160-6b3a8d3a012b.kml"
HYD = OPENCITY + "fc638a1b-342b-46e1-bb2f-15a1c425b86c/resource/0b46c486-3a6f-47e8-aaf3-2f3b878ed104/download/hyd_police_stations.geojson"
TELANGANA = OPENCITY + "fc638a1b-342b-46e1-bb2f-15a1c425b86c/resource/a3db8870-16a0-4f61-9026-dcbb60813426/download/tg_police_stations.geojson"
PS = re.compile(r"\bw?p\.?\s?s\b|police station", re.I)
GONE = re.compile(r"\bold\b|un ?constructed|condemned", re.I)
NOT_STATION = re.compile(r"out ?post|training|\boffice\b|open land|barrack|quarter|police line", re.I)
TRAFFIC = re.compile(r"traffic|tr\.?\s?p\.?\s?s\b", re.I)


def utm_to_lnglat(x, y, zone=44):
    """WGS84 UTM (northern hemisphere) to (lng, lat), USGS series; sub-metre in India."""
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
         + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    c1, t1 = ep2 * math.cos(p) ** 2, math.tan(p) ** 2
    n1 = a / math.sqrt(1 - e2 * math.sin(p) ** 2)
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p) ** 2) ** 1.5
    d = (x - 500000) / (n1 * k0)
    lat = p - (n1 * math.tan(p) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                         + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lng = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p)
    return (zone - 1) * 6 - 180 + 3 + math.degrees(lng), math.degrees(lat)


def is_station(name):
    """A working law-and-order station: 'Uppal PS', 'Kulsumpura_PS_&_Quarters', 'FalaknamaPS'; not old or unbuilt
    buildings, traffic stations, quarters, outposts, offices or training centres on their own."""
    raw = " ".join((name or "").replace("_", " ").split())
    if TRAFFIC.search(raw) or GONE.search(raw):
        return False
    n = re.sub(r"\(.*?\)", " ", raw)   # '(Moghalpura PS)' only names the parent station
    if not (PS.search(n) or re.search(r"[a-z]PS\b", n)):
        return False
    return "&" in n or not NOT_STATION.search(n)


def mumbai_points(text):
    return [(x, y, p) for x, y, p in kml_points(text) if (p.get("SUBTYPE") or "").strip().lower() == "station"]


def telangana_points(doc):
    out = []
    for f in doc.get("features") or []:
        g, p = f.get("geometry") or {}, f.get("properties") or {}
        if g.get("type") != "Point" or not is_station(p.get("Name_of_the_Property")):
            continue
        x, y = g["coordinates"][:2]
        out.append((*utm_to_lnglat(x, y), p) if x > 1000 else (x, y, p))
    return out


def fetch(region):
    import requests
    get = lambda u: requests.get(u, timeout=300).content.decode("utf-8-sig")
    if region == "mumbai":
        return mumbai_points(get(MUMBAI)), []
    if region == "bengaluru":
        return kml_points(get(BLR_PS)), kml_points(get(BLR_OP))
    if region == "hyderabad":
        return telangana_points(json.loads(get(HYD))) + telangana_points(json.loads(get(TELANGANA))), []
    raise ValueError(region)


COVERED = ("mumbai", "bengaluru")   # Hyderabad's jurisdiction map covers only the city commissionerate


def jurisdiction_cells(region, root=CELLS):
    """L7 blocks the ``police_stations`` jurisdiction dataset assigns to a station, or None."""
    from pipeline.cells import store
    if region not in COVERED:
        return None
    cat = json.loads((root / "catalog.json").read_text())
    ds = next((d for d in (cat.get("datasets") or []) if d["id"] == "police_stations"), None)
    entry = ds and next((r for r in ds["regions"] if r["name"] == region), None)
    if not entry:
        return None
    t = store.read_region(root, entry)
    return [c for c, v in zip(t.codes, t.columns["station"]) if v is not None]


def records(stations, outposts, area=None):
    for code in area or ():
        yield {"digipin": code, "in_area": 1}
    for lng, lat in stations:
        yield {"lat": lat, "lng": lng, "stations": 1}
    for lng, lat in outposts:
        yield {"lat": lat, "lng": lng, "outposts": 1}


def cell_dataset(region, stations, outposts, area=None):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("stations", "Police stations (state police map)", agg="sum", unit="stations", ramp="blues", higher_is="better"),
        FieldSpec("outposts", "Police outposts (Bengaluru)", agg="sum", unit="outposts", ramp="blues", higher_is="better"),
        FieldSpec("in_area", "Inside the city police's jurisdiction map", agg="max", unit="", domain=[0, 1], ramp="blues", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="police_official", title="Police stations (state police maps)", level=LEVEL, fields=specs, group="Safety",
        description="Police stations from the state police maps on data.opencity.in, counted per block: Mumbai Police (BMC "
                    "disaster management GIS), Karnataka Police KGIS stations and outposts for Bengaluru Urban, and "
                    "Telangana Police stations for the Hyderabad region.",
        source="pipeline/realestate/police.py (OpenCity police station maps)",
        license="Public domain (Mumbai Police, Karnataka Police, Telangana Police via data.opencity.in)", default_field="stations", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(records(stations, outposts, area), LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import bbox_for
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="mumbai,bengaluru,hyderabad")
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        ps, op = fetch(r)
        bbox = bbox_for(r)
        st, ou = dedupe(ps, bbox), dedupe(op, bbox)
        info = cell_dataset(r, st, ou, jurisdiction_cells(r))
        print(f"{r}: {len(st)} stations, {len(ou)} outposts in {info['cells']} blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
