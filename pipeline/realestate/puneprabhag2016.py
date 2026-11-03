"""Footpaths, storm-water drains and slum households by Pune's 2012 prabhags: PMC's 2016 prabhag tables (OpenCity, public
domain) on DataMeet's 2012 electoral ward map (CC BY 4.0).

PMC's 2016 tables give one row per 2012 prabhag (76 of them, the wards PMC used from 2012 to 2017): length of roads and
of roads with a footpath on one or both sides and the share with usable footpaths; the share of roads with a storm-water
drain; and slum households. DataMeet's Municipal Spatial Data has the same 76 prabhags traced (``Pune/pune-electoral-
wards_2012.geojson``, ``wardnum`` 1-76; ward 1 Lohegaon, 2 Kharadi, 76 Katraj check out). Each lived-in L7 block whose
centre lies in a prabhag takes its row (dataset ``pune_prabhag_2016``):

    pp_prabhag          2012 prabhag number
    pp_footpath_pct     share of road length with usable footpaths
    pp_footpath_ratio   km of road with a footpath on at least one side per km of road
    pp_swd_pct          share of road length with a storm-water drain
    pp_slum_hh          slum households in the prabhag
    pp_road_km          road length in the prabhag

PMC's household drainage-connection table on the same prabhags is not used: 61 of 76 rows read 100% and the rest are
round 85/90/95, so it looks filled in rather than measured. The slum area column has no unit and is not used either.

    python -m pipeline.realestate.puneprabhag2016
"""
from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
WARDS = "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Pune/pune-electoral-wards_2012.geojson"
B = "https://data.opencity.in/dataset/"
TABLES = {
    "foot": B + "afe477a7-60a3-44c8-bf87-78ac6ec03822/resource/223540aa-69cd-47d6-939f-2c6378594002/download/76785b37-893d-4c11-ac39-ad4dfb5e2db8.csv",
    "swd": B + "0825c18f-0bcb-4fa6-9a6f-cddc19306fcc/resource/8f7f9379-62b3-4080-8c38-1f853d76e242/download/b04cc181-c7b2-4082-aace-817be8f4cc98.csv",
    "slum": B + "410f4413-ffab-4637-802c-31f64f279d06/resource/4ed3e09f-8c19-4f58-9edd-68c50a80a49a/download/26eb7645-7ab7-4940-a8bb-e9ce0e76042e.csv",
}


def _f(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def prabhag_rows(foot, swd, slum):
    """{prabhag no: fields} from the three tables (lists of dict rows)."""
    out = {}
    for r in foot:
        n = int(_f(r["Prabhag_no"]))
        road = _f(r["length_of_roads"])
        both, one = _f(r["length_of_roads_with_footpath_on_both_sides"]) or 0, _f(r["length_of_roads_with_footpath_on_one_side"]) or 0
        row = {"pp_prabhag": n, "pp_footpath_pct": _f(r["Percentage_of_roads_with_usable_footpaths"]), "pp_road_km": road}
        if road:
            row["pp_footpath_ratio"] = round(min(1.0, (both + one) / road), 2)
        out[n] = row
    for r in swd:
        n = int(_f(r["Prabhag_no"]))
        out.setdefault(n, {"pp_prabhag": n})["pp_swd_pct"] = _f(r["Percentage_of_roads_with_storm_water_drainage"])
    for r in slum:
        n = int(_f(r["Prabhag_no"]))
        hh = _f(r["slum_hh"])
        if hh is not None:
            out.setdefault(n, {"pp_prabhag": n})["pp_slum_hh"] = int(hh)
    return {n: {k: v for k, v in row.items() if v is not None} for n, row in out.items()}


def assign(cells, feats):
    """{code: prabhag no} for blocks whose centre lies in a 2012 prabhag (DuckDB spatial)."""
    import duckdb

    from pipeline.realestate.wards import closed
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
    con.executemany("INSERT INTO w VALUES (?, ST_GeomFromGeoJSON(?))",
                    [(int(f["properties"]["wardnum"]), json.dumps(g)) for f in feats if (g := closed(f["geometry"]))])
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", cells)
    return dict(con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(ST_MakeValid(w.geom), ST_Point(c.x, c.y)) GROUP BY 1").fetchall())


def cell_dataset(region, recs):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("pp_footpath_pct", "Roads with usable footpaths in the 2012 prabhag, 2016", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is="better"),
        FieldSpec("pp_footpath_ratio", "Road km with a footpath on at least one side per road km, 2016", agg="mean", unit="ratio", domain=[0, 1], ramp="viridis", higher_is="better"),
        FieldSpec("pp_swd_pct", "Roads with a storm-water drain in the 2012 prabhag, 2016", agg="mean", unit="%", domain=[0, 100], ramp="viridis", higher_is="better"),
        FieldSpec("pp_slum_hh", "Slum households in the 2012 prabhag, 2016", agg="max", unit="households", ramp="reds", higher_is=None),
        FieldSpec("pp_road_km", "Road length in the 2012 prabhag, 2016", agg="max", unit="km", ramp="viridis", higher_is=None),
        FieldSpec("pp_prabhag", "2012 PMC prabhag number", agg="mode", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="pune_prabhag_2016", title="Footpaths, drains and slums by prabhag (PMC 2016)", level=LEVEL, fields=specs, group="Mobility",
        description="PMC's 2016 prabhag tables (via data.opencity.in) for the 76 prabhags of 2012-2017: usable footpaths, roads "
                    "with storm-water drains and slum households, placed on DataMeet's trace of the 2012 electoral wards.",
        source="pipeline/realestate/puneprabhag2016.py (PMC prabhag tables via OpenCity; DataMeet pune-electoral-wards_2012)",
        license="Public domain (PMC via data.opencity.in); ward map CC BY 4.0 (DataMeet Municipal Spatial Data)",
        default_field="pp_footpath_pct", extrude=False)
    return store.write_dataset(CELLS, spec, region, store.bin_records(recs, LEVEL, specs), parquet=False)


def main(argv=None):
    import requests

    from pipeline.realestate.powerplants import lived_cells
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.parse_args(argv)
    get = lambda u: list(csv.DictReader(io.StringIO(requests.get(u, timeout=120).content.decode("utf-8-sig"))))
    rows = prabhag_rows(get(TABLES["foot"]), get(TABLES["swd"]), get(TABLES["slum"]))
    feats = requests.get(WARDS, timeout=120).json()["features"]
    where = assign(lived_cells("pune"), feats)
    recs = [{"digipin": c, **rows[n]} for c, n in where.items() if n in rows]
    info = cell_dataset("pune", recs)
    print(f"pune: {len(rows)} prabhags, {len(recs)} blocks inside the 2012 map; {info['cells']} cells")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
