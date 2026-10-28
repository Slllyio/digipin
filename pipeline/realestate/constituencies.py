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
        id="constituencies", title="Assembly and Lok Sabha constituencies (DataMeet)", level=LEVEL, fields=specs, group="Real estate",
        description="The assembly constituency (and the Lok Sabha constituency it sits in) holding each lived-in block's centre: "
                    "2008 delimitation boundaries scraped by DataMeet from the Election Commission's polling station locator "
                    "(github.com/datameet/maps). Some boundaries are shifted and a few names are wrong or missing; check the "
                    "Election Commission before relying on a seat at an edge.",
        source="pipeline/realestate/constituencies.py (DataMeet India assembly constituencies via DuckDB spatial)",
        license="CC BY 2.5 India (DataMeet)", default_field="assembly", extrude=False)
    clean_rows = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean_rows, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline._lib.regions import CITY_PILOTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        shp = download(tmp)
        for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
            rows = fetch(r, shp)
            print(f"{r}: {len(rows)} blocks in {len({x.get('assembly') for x in rows.values()})} assembly and "
                  f"{len({x.get('lok_sabha') for x in rows.values()})} Lok Sabha constituencies")
            if rows:
                cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
