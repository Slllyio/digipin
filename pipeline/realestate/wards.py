"""Municipal ward per block, from city ward maps (OpenCity and DataMeet).

Per L7 block (dataset ``wards``):

    ward        the municipal ward holding the block centre, as "number name" where the source names it
    ward_no     the ward number (or code)
    zone        the administrative zone or ward group, where the source has one
    body        the urban local body (BBMP, GHMC, MCD ...), so blocks outside the corporation stay blank

Boundaries come from the newest public map found for each city: OpenCity's public-domain ward maps (data.opencity.in:
Bengaluru's 369 GBA wards of December 2025, Ahmedabad, Indore, Bhopal, Greater Jaipur, Gurugram, Faridabad and Navi
Mumbai 2024, Thane 2023, Hyderabad and Kolkata 2022) and github.com/datameet/Municipal_Spatial_Data (CC BY 4.0) for the
rest. Each city lists its layers in priority order, so a metro block outside the core corporation still gets its own
body (Gurugram, Thane). Some maps predate the latest delimitation (Delhi's is the 2017 MCD map; MCD has had 250 wards
since 2022), so read the ward as the one on that map. Guna has no ward map.

    python -m pipeline.realestate.wards --region all
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RAW = "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/"


def _num_name(s):
    """'48 RAMOL HATHIJAN' -> ('48', 'Ramol Hathijan'); 'Ward 91 Khairatabad' -> ('91', 'Khairatabad')."""
    m = re.match(r"^\s*(?:ward\s*)?(\d+)\s*[-.:]?\s*(.*)$", str(s or ""), re.IGNORECASE)
    return (m.group(1), m.group(2).strip()) if m else (None, str(s or "").strip())


def _title(s):
    s = str(s or "").strip()
    return s.title() if s.isupper() else s


def _delhi(p):
    """MCD wards are numbered; NDMC and Delhi Cantonment appear as charges ('NDMC_3', 'CANT_2')."""
    no, name = str(p.get("Ward_No") or ""), _title(p.get("Ward_Name"))
    for pre, body in (("NDMC_", "NDMC"), ("CANT_", "Delhi Cantonment Board")):
        if no.startswith(pre):
            return no[len(pre):], f"{body} charge {no[len(pre):]}", None, body
    return no or None, name, None


OPENCITY = "https://data.opencity.in/dataset/"


def _sd(p, *keys):
    for k in keys:
        v = p.get(k)
        if v not in (None, ""):
            return str(v).strip()
    return None


def _lgd(p):
    """OpenCity/LGD ward maps: ('12', 'Naroda') from sourcewardcode and sourcewardname or ward_lgd_name."""
    no = _sd(p, "sourcewardcode", "wardcode")
    name = _sd(p, "sourcewardname", "ward_lgd_name", "lgd_name")
    if name and re.search(r"ward\s*no\.?\s*\d+|^\s*ward\s*\d+\s*$", name, re.IGNORECASE):
        name = None                      # "Gurgaon (M Cl ) - Ward No.1" carries no name beyond the number
    return no, _title(name), None


def _gba(p):
    corp = _sd(p, "Corporation")
    return _sd(p, "ward_id"), _sd(p, "ward_name"), None, f"Bengaluru {corp} City Corporation" if corp else "GBA"


def _ghmc(p):
    no, name = _num_name(re.sub(r"^(\d+)\s*-\s*", r"\1 ", _sd(p, "ward") or ""))
    zone = _sd(p, "ZONE")
    return no, _title(name), _title(zone.replace(" ZONE", "")) + " zone" if zone else None


# city -> layers in priority order: (body, kind, path, fn(props) -> (ward_no, name, zone[, body]), map year)
SOURCES = {
    "ahmedabad": [("AMC", "kml", "f7505ef4-810a-4119-a649-8e8fb1287e5e/resource/d251953b-6168-4c73-a496-40e53ffb9349/download/6a6d025b-2b02-4b0e-8bb8-74186eacf071.kml", _lgd, "2024")],
    "bengaluru": [("GBA", "kml", "863209cb-4ced-4f51-b5c5-156939c50922/resource/9013d656-8051-4e2d-9648-46efd0d86d3d/download/gba-369-wards-december-2025.kml", _gba, "2025")],
    "bhopal": [("BMC Bhopal", "kml", "b30bd319-3db6-4dde-9064-ae07d4a127b5/resource/9b8325e9-44ec-448b-890c-1c19f312d06b/download/f0ee298b-cf85-43f0-87d5-34e836761d76.kml", _lgd, "2024")],
    "chennai": [("GCC", "geojson", "Chennai/Wards.geojson", lambda p: (p.get("Ward_No"), None, p.get("Zone_Name") and _title(p["Zone_Name"])), "2011")],
    "delhi": [("MCD", "geojson", "Delhi/Delhi_Wards.geojson", lambda p: _delhi(p), "2017"),
              ("MC Gurugram", "kml", "6a0a1e94-46ac-4d4a-b7f4-899eb4551b70/resource/802f00d5-38ab-45a5-823b-45dd870fd572/download/1dad3e7e-38e3-4a2f-9126-f439e7f8992e.kml", _lgd, "2024"),
              ("MC Faridabad", "kml", "b242d935-5501-44ce-8da4-5cc1aeca5dc6/resource/9d2549ac-91ff-46df-89fb-aebecaacfa0b/download/da7bedea-ffc1-488e-90e8-66650766a4de.kml", _lgd, "2024")],
    "hyderabad": [("GHMC", "kml", "15cb7d8d-eed1-4aad-8cd7-f281cbf4f94f/resource/14b033e3-3721-4149-8326-cc29420e062e/download/ghmc_wards.kml", _ghmc, "2022")],
    "indore_pilot": [("IMC", "kml", "909d2645-48ab-4476-916a-b1536f661407/resource/dd1c7978-7c7b-41ca-8790-ce6c58ad625d/download/9b8f3f8a-3480-42d5-bc1c-09c9d69c4717.kml", _lgd, "2024")],
    "jaipur": [("Greater Jaipur MC", "kml", "9a088bcc-0192-4070-b2e6-6cb050c742e0/resource/97dc97d0-baac-485f-93c1-0f2163d75dc3/download/43a00975-c97f-45d8-9b36-b3acbf0fb5eb.kml", _lgd, "2024"),
               ("JMC (pre-2020 map)", "geojson", "Jaipur/Jaipur_Wards.geojson", lambda p: (p.get("WARD_NO"), None, p.get("ZONE_NAME") and _title(p["ZONE_NAME"])), None)],
    "kolkata": [("KMC", "kml", "e1c4f558-eff2-44c3-b703-d9d6ea45c577/resource/b3195f54-6c85-4cb4-afa0-06af482fe9df/download/10f7cc2f-5005-412f-861d-d5e085dd92fb.kml", lambda p: (_sd(p, "WARD"), None, None), "2022")],
    "lucknow": [("LMC", "geojson", "Lucknow/Lucknow_ward_boundary.geojson", lambda p: (p.get("Ward Num"), p.get("Ward Name"), p.get("Zone") and f"Zone {p['Zone']}"), None)],
    "mumbai": [("BMC", "geojson", "Mumbai/BMC_Wards.geojson", lambda p: (p.get("name"), None, None), None),
               ("TMC Thane", "kml", "03db6016-c665-4c05-99da-86188f80a46d/resource/c426c5c2-a179-46e4-8349-857248e63613/download/bec13773-610a-402c-838a-8d2056eb4036.kml", _lgd, "2023"),
               ("NMMC", "kml", "e94cdb12-f4a3-469b-9ebe-7cb017059efc/resource/3b24c5a8-f6f4-4505-9dc1-2724b8299e62/download/ad265aaa-2967-45a1-a0a4-17530f0d2a6d.kml", _lgd, "2024")],
    "pune": [("PMC", "geojson", "Pune/pune-electoral-wards_2022.geojson", lambda p: (p.get("wardnum"), p.get("Name2"), None), "2022")],
}


def kml_features(text):
    """GeoJSON-like features from a KML with SimpleData attributes and (Multi)Polygon geometry."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)
    tag = lambda e: e.tag.rsplit("}", 1)[-1]
    ring = lambda e: [[float(v) for v in xy.split(",")[:2]] for xy in (e.text or "").split() if "," in xy]
    out = []
    for pm in (e for e in root.iter() if tag(e) == "Placemark"):
        props = {d.get("name"): (d.text or "").strip() for d in pm.iter() if tag(d) == "SimpleData"}
        polys = []
        for pg in (e for e in pm.iter() if tag(e) == "Polygon"):
            rings = []
            for b in pg:
                if tag(b) in ("outerBoundaryIs", "innerBoundaryIs"):
                    c = next((e for e in b.iter() if tag(e) == "coordinates"), None)
                    if c is not None:
                        (rings.insert(0, ring(c)) if tag(b) == "outerBoundaryIs" else rings.append(ring(c)))
            if rings:
                polys.append(rings)
        if polys:
            out.append({"properties": props, "geometry": {"type": "MultiPolygon", "coordinates": polys}})
    return out


def label(no, name):
    no = None if no in (None, "") else str(no)
    if no and name:
        return f"{no} {name}"
    return no or (name or None)


def closed(geom):
    """Close unclosed rings and drop degenerate ones (some ward files have them)."""
    def ring(r):
        r = [p[:2] for p in r]
        if r and r[0] != r[-1]:
            r = r + [r[0]]
        return r if len(r) >= 4 else None

    def poly(rings):
        out = [x for x in (ring(r) for r in rings) if x]
        return out or None
    if geom["type"] == "Polygon":
        c = poly(geom["coordinates"])
        return {"type": "Polygon", "coordinates": c} if c else None
    if geom["type"] == "MultiPolygon":
        c = [x for x in (poly(p) for p in geom["coordinates"]) if x]
        return {"type": "MultiPolygon", "coordinates": c} if c else None
    return None


def lived_cells(region):
    from pipeline.realestate.powerplants import lived_cells as lc
    return lc(region)


def layer_features(kind, path):
    import requests
    r = requests.get((RAW if kind == "geojson" else OPENCITY) + path, timeout=180)
    r.raise_for_status()
    text = r.content.decode("utf-8-sig")
    return json.loads(text)["features"] if kind == "geojson" else kml_features(text)


def fetch(region):
    """{code: row} for the lived-in blocks of a region inside a mapped ward; earlier layers win."""
    import duckdb
    cells = lived_cells(region)
    rows = {}
    for body, kind, path, fn, _ in SOURCES[region]:
        feats = layer_features(kind, path)
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
        con.executemany("INSERT INTO w VALUES (?, ST_GeomFromGeoJSON(?))",
                        [(k, json.dumps(g)) for k, g in ((k, closed(f["geometry"])) for k, f in enumerate(feats) if f.get("geometry")) if g])
        con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
        con.executemany("INSERT INTO c VALUES (?, ?, ?)", [c for c in cells if c[0] not in rows])
        hits = con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(ST_MakeValid(w.geom), ST_Point(c.x, c.y)) GROUP BY 1").fetchall()
        for code, k in hits:
            no, name, zone, *own = fn(feats[k]["properties"])
            row = {"ward": label(None if own and body == "MCD" else no, name), "ward_no": None if no in (None, "") else str(no), "zone": zone,
                   "body": own[0] if own else body}
            rows[code] = {a: b for a, b in row.items() if b}
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("ward", "Municipal ward", type="category", agg="mode"),
        FieldSpec("ward_no", "Ward number", type="category", agg="mode"),
        FieldSpec("zone", "Municipal zone", type="category", agg="mode"),
        FieldSpec("body", "Municipal corporation", type="category", agg="mode"),
    ]
    maps = "; ".join(f"{b} {y or 'map year not stated'} ({'OpenCity' if k == 'kml' else 'DataMeet'})" for b, k, _, _, y in SOURCES[region])
    spec = DatasetSpec(
        id="wards", title="Municipal wards (OpenCity, DataMeet)", level=LEVEL, fields=specs, group="Real estate",
        description="The municipal corporation ward (and zone, where mapped) holding each lived-in block's centre, from the newest "
                    f"public ward map found for the city ({region}: {maps}). Use it to join ward-level budgets, grievances and "
                    "election results of that map; a corporation may have redrawn wards since.",
        source="pipeline/realestate/wards.py (OpenCity and DataMeet ward maps via DuckDB spatial)",
        license="Public domain (OpenCity, data.opencity.in) and CC BY 4.0 (DataMeet Municipal Spatial Data)", default_field="ward", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        if r not in SOURCES:
            print(f"{r}: no ward map")
            continue
        rows = fetch(r)
        print(f"{r}: {len(rows)} blocks in {len({(x.get('body'), x.get('ward_no')) for x in rows.values()})} wards of "
              f"{', '.join(sorted({x.get('body', '?') for x in rows.values()}))}")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
