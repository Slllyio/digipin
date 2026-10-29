"""Assembly (MLA) and Lok Sabha (MP) constituency per block, from DataMeet's India assembly constituency map.

Per L7 block (dataset ``constituencies``):

    assembly    the assembly constituency holding the block centre ("Malviya Nagar")
    ac_no       its number in the state
    lok_sabha   the parliamentary constituency it belongs to ("New Delhi")
    pc_no       its number in the state
    reserved    'SC' or 'ST' where the assembly seat is reserved

Boundaries are the 2008 delimitation (still in force), scraped by DataMeet from the Election Commission's polling
station locator (github.com/datameet/maps, assembly-constituencies, CC BY 2.5 India). The README warns of some shift
and a few wrong or missing names; Telangana seats are still filed under Andhra Pradesh there.

Where a state's own map is on OpenCity (public domain), it replaces DataMeet's: Karnataka's KGIS map (2018) for
Bengaluru and Telangana's map (2018) for Hyderabad. Checked against 2024 electors per assembly segment, these put
people in the right seats more often (Hyderabad's median gap between electors and GHSL residents per seat fell from
0.37 to 0.26 in log terms, Bengaluru's from 0.07 to 0.04). Numbers and Lok Sabha seats come from the Election
Commission's 2024 segment table, matched by number (Karnataka) or name (Telangana). The Maharashtra, West Bengal and
Tamil Nadu maps on OpenCity put 97-98% of blocks in the same seat as DataMeet, so Mumbai, Pune, Kolkata and Chennai
keep DataMeet's. Jaipur's DataMeet seats are badly shifted (Bagru covers the city centre) and no better map is open.

    python -m pipeline.realestate.constituencies --region all
"""
from __future__ import annotations

import argparse
import re
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
RAW = "https://raw.githubusercontent.com/datameet/maps/master/assembly-constituencies/India_AC."
OPENCITY = "https://data.opencity.in/dataset/"
# region -> (state in the ECI tables, OpenCity KML, properties -> (AC number or None, AC name))
STATE_MAPS = {
    "bengaluru": ("Karnataka", "f80a1ff2-a1f2-442a-aff0-f332acd14ae6/resource/4de072f1-8b5d-4242-b3f4-aec56cc88865/download/"
                               "1e5b1f22-37c6-4652-aef8-8f783e246135.kml", lambda p: (p.get("AC_CODE"), p.get("AC_NAME"))),
    "hyderabad": ("Telangana", "ddf1cb4a-1433-4e8b-aeeb-afb2d5ba5021/resource/ab8095a4-cc07-4a73-8da2-3458baab4600/download/"
                               "8137a4f0-4d33-48d9-ae93-23b2bf558424.kml", lambda p: (None, p.get("ASSEMBLY_N"))),
}


def clean(name):
    """'NORTH WEST DELHI (SC)' -> ('North West Delhi', 'SC'); 'Nerela' -> ('Nerela', None)."""
    s = str(name or "").strip()
    m = re.search(r"\s*\((SC|ST)\)\s*$", s, re.IGNORECASE)
    res = m.group(1).upper() if m else None
    s = s[:m.start()] if m else s
    s = re.sub(r"\s+", " ", s).strip(" -")
    return (s.title() if s.isupper() else s) or None, res


def download(dest):
    import requests
    for ext in ("shp", "shx", "dbf", "prj"):
        r = requests.get(RAW + ext, timeout=300)
        r.raise_for_status()
        (Path(dest) / f"India_AC.{ext}").write_bytes(r.content)
    return Path(dest) / "India_AC.shp"


def fetch(region, shp):
    """{code: row} for the lived-in blocks of a region."""
    import duckdb

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.powerplants import lived_cells
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"""CREATE TABLE a AS SELECT AC_NO, AC_NAME, PC_NO, PC_NAME, ST_MakeValid(geom) AS geom FROM ST_Read('{shp}')
                    WHERE ST_Intersects(geom, ST_MakeEnvelope({w}, {s}, {e}, {n}))""")
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", lived_cells(region))
    hits = con.execute("""SELECT c.code, arg_min(a.AC_NO, ST_Area(a.geom)), arg_min(a.AC_NAME, ST_Area(a.geom)),
                                 arg_min(a.PC_NO, ST_Area(a.geom)), arg_min(a.PC_NAME, ST_Area(a.geom))
                          FROM c JOIN a ON ST_Contains(a.geom, ST_Point(c.x, c.y)) GROUP BY 1""").fetchall()
    rows = {}
    for code, acn, acname, pcn, pcname in hits:
        ac, res = clean(acname)
        pc, _ = clean(pcname)
        row = {"assembly": ac, "ac_no": acn, "lok_sabha": pc, "pc_no": pcn, "reserved": res}
        rows[code] = {k: v for k, v in row.items() if v is not None}
    return rows


def seats(segs, state):
    """{AC number: (name, PC number, PC name)} for one state from the ECI segment table (elections.parse_segments)."""
    return {no: (name, s["pc_no"], s["pc_name"]) for (no, name, st), s in segs.items() if st == state}


def resolve(no, name, by_no):
    """(AC number, ECI name, PC number, PC name) for a state-map seat, by number when it has one, else by name."""
    from pipeline.realestate.elections import best
    if no not in (None, "") and str(no).strip().isdigit() and int(no) in by_no:
        n = int(no)
        return (n, *by_no[n])
    return best(clean(name)[0], [(v[0], (k, *v)) for k, v in by_no.items()])


def state_rows(region, old, segs):
    """{code: row} from the region's OpenCity state map; reservation from the seat name, else DataMeet's for that number."""
    import json

    import duckdb
    import requests

    from pipeline.realestate.powerplants import lived_cells
    from pipeline.realestate.wards import closed, kml_features
    state, path, props = STATE_MAPS[region]
    r = requests.get(OPENCITY + path, timeout=300)
    r.raise_for_status()
    feats = kml_features(r.content.decode("utf-8-sig"))
    by_no = seats(segs, state)
    reserved = {x["ac_no"]: x["reserved"] for x in old.values() if x.get("reserved") and x.get("ac_no") is not None}
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
    con.executemany("INSERT INTO w VALUES (?, ST_MakeValid(ST_GeomFromGeoJSON(?)))",
                    [(k, json.dumps(g)) for k, g in ((k, closed(f["geometry"])) for k, f in enumerate(feats)) if g])
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", lived_cells(region))
    rows, memo = {}, {}
    for code, k in con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(w.geom, ST_Point(c.x, c.y)) GROUP BY 1").fetchall():
        if k not in memo:
            no, name = props(feats[k]["properties"])
            hit = resolve(no, name, by_no)
            if not hit:
                memo[k] = None
                continue
            acn, acname, pcn, pcname = hit
            res = clean(name)[1] or reserved.get(acn)
            row = {"assembly": clean(acname)[0], "ac_no": acn, "lok_sabha": clean(pcname)[0], "pc_no": pcn, "reserved": res}
            memo[k] = {a: b for a, b in row.items() if b is not None}
        if memo[k]:
            rows[code] = memo[k]
    return rows


def seat_shares(region, segs):
    """{AC number: share of the seat's area inside the region's box}, from the same map the region's seats come from."""
    import json

    import duckdb
    import requests

    from pipeline._lib.regions import bbox_for
    from pipeline.realestate.wards import closed, kml_features
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE a (ac INTEGER, geom GEOMETRY)")
    if region in STATE_MAPS:
        state, path, props = STATE_MAPS[region]
        r = requests.get(OPENCITY + path, timeout=300)
        r.raise_for_status()
        by_no = seats(segs, state)
        for f in kml_features(r.content.decode("utf-8-sig")):
            hit, g = resolve(*props(f["properties"]), by_no), closed(f["geometry"])
            if hit and g:
                con.execute("INSERT INTO a VALUES (?, ST_MakeValid(ST_GeomFromGeoJSON(?)))", [hit[0], json.dumps(g)])
        con.execute(f"DELETE FROM a WHERE NOT ST_Intersects(geom, ST_MakeEnvelope({w}, {s}, {e}, {n}))")
    else:
        with tempfile.TemporaryDirectory() as tmp:
            con.execute(f"""INSERT INTO a SELECT AC_NO, ST_MakeValid(geom) FROM ST_Read('{download(tmp)}')
                            WHERE ST_Intersects(geom, ST_MakeEnvelope({w}, {s}, {e}, {n}))""")
    return dict(con.execute(f"""SELECT ac, sum(ST_Area(ST_Intersection(geom, ST_MakeEnvelope({w}, {s}, {e}, {n})))) / sum(ST_Area(geom))
                                FROM a GROUP BY 1""").fetchall())


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("assembly", "Assembly constituency (MLA)", type="category", agg="mode"),
        FieldSpec("ac_no", "Assembly constituency number", agg="max", unit="no."),
        FieldSpec("lok_sabha", "Lok Sabha constituency (MP)", type="category", agg="mode"),
        FieldSpec("pc_no", "Lok Sabha constituency number", agg="max", unit="no."),
        FieldSpec("reserved", "Reserved assembly seat (SC or ST)", type="category", agg="mode"),
    ]
    spec = DatasetSpec(
        id="constituencies", title="Assembly and Lok Sabha constituencies", level=LEVEL, fields=specs, group="Real estate",
        description="The assembly constituency (and the Lok Sabha constituency it sits in) holding each lived-in block's centre: "
                    "2008 delimitation boundaries scraped by DataMeet from the Election Commission's polling station locator "
                    "(github.com/datameet/maps). Some boundaries are shifted and a few names are wrong or missing; check the "
                    "Election Commission before relying on a seat at an edge. Bengaluru and Hyderabad use the state maps on "
                    "OpenCity instead (Karnataka KGIS 2018, Telangana 2018), which fit 2024 electors better, with numbers and "
                    "Lok Sabha seats from the Election Commission's 2024 segment table. Jaipur's seats are badly shifted.",
        source="pipeline/realestate/constituencies.py (DataMeet India assembly constituencies; OpenCity state maps for Bengaluru and Hyderabad)",
        license="CC BY 2.5 India (DataMeet); public domain (OpenCity state maps)", default_field="assembly", extrude=False)
    clean_rows = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean_rows, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    from pipeline.realestate.elections import SEGMENTS, _csv, parse_segments
    segs = None
    with tempfile.TemporaryDirectory() as tmp:
        shp = download(tmp)
        for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
            rows = fetch(r, shp)
            if r in STATE_MAPS:
                segs = segs or parse_segments(_csv(SEGMENTS))
                rows = state_rows(r, rows, segs)
            print(f"{r}: {len(rows)} blocks in {len({x.get('assembly') for x in rows.values()})} assembly and "
                  f"{len({x.get('lok_sabha') for x in rows.values()})} Lok Sabha constituencies")
            if rows:
                cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
