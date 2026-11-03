"""Road crashes by Bengaluru Traffic Police station jurisdiction, 2018-2025 (OpenCity, public domain).

Per lived-in L7 block in Bengaluru (dataset ``road_crashes``), the values of the traffic police jurisdiction holding it:

    station            traffic police station (2022 jurisdiction map)
    crashes_yr         reported road crashes a year, 2023-2025 mean
    fatal_yr           fatal crashes a year, 2023-2025 mean
    crashes_per_km2    crashes a year per km² of the jurisdiction
    fatal_per_km2      fatal crashes a year per km²
    fatal_change_pct   fatal crashes 2023-2025 against 2018-2019 (%)

BTP publishes station-wise totals each year; the jurisdiction polygons are its 2022 map. Stations opened since 2022 (for
example Mahadevapura, Bellanduru, JP Nagar) are added to the 2022 jurisdiction they were carved from, so every year is
counted on the same 47 areas; that parent is a judgement, noted in PARENT.

    python -m pipeline.realestate.btpcrashes
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
REGION = "bengaluru"
OPENCITY = "https://data.opencity.in/dataset/"
MAP = "ba9be930-e313-4f16-b4e2-39a5d8d7eb3f/resource/3e7e6a4d-4dce-44ec-aef3-64278c30c06f/download/faceb23a-79e8-47e9-b9ba-c418c5cf6e9c.kml"
API = "https://data.opencity.in/api/3/action/package_show?id=bengaluru-road-crashes-data"
RECENT = (2023, 2024, 2025)
BASE = (2018, 2019)
# crash-table spellings -> 2022 map names (after key())
ALIAS = {"airport": "hal", "ashokanagar": "ashokanagara", "banasawadi": "banaswadi", "bpura": "byatarayanapura",
         "bytarayanapura": "byatarayanapura", "chamarajapet": "chamarajpet", "chikjala": "chikkajala", "ftown": "pulakeshinagar",
         "pulikeshinagar": "pulakeshinagar", "halasooru": "halasur", "ulsoor": "halasur", "hebbala": "hebbal", "hennuru": "hennur",
         "hgrounds": "highgrounds", "indiranagar": "jeevanbheemanagar", "intaiport": "devanahalli", "kghalli": "kadugondanahalli",
         "krpura": "krpuram", "kslayout": "kumaraswamylayout", "kswamylyt": "kumaraswamylayout", "madivala": "madiwala",
         "malleshwaram": "malleshwarm", "malleswaram": "malleshwarm", "micolayout": "micolayoutbangalore", "ssnagar": "sadashivanagar",
         "ugate": "halasurgate", "wgarden": "wilsongarden", "yalahanka": "yelahanka", "yashawanthapura": "yeshwanthapura",
         "ypura": "yeshwanthapura"}
# stations without a 2022 polygon -> the jurisdiction they were carved from (or merged into)
PARENT = {"mahadevapura": "krpuram", "bellanduru": "hsrlayout", "jpnagar": "jayanagar", "thalagattapura": "kumaraswamylayout",
          "jnanabharathi": "kengeri", "kodigehalli": "hebbal", "chickpet": "upparpet", "sheshadripuramchickpet": "upparpet"}


def key(s):
    k = re.sub(r"[^a-z]", "", re.sub(r"\b(traffic|ps)\b", "", (s or "").lower()))
    k = ALIAS.get(k, k)
    return PARENT.get(k, k)


def _n(x):
    try:
        return float(str(x).replace(",", ""))
    except ValueError:
        return None


def parse_table(text):
    """{(year, 'total'|'fatal'): {station key: count}} from one BTP station-wise CSV (any of its layouts)."""
    rows = list(csv.reader(io.StringIO(text)))
    head = [h.strip() for h in rows[0]]
    st = head.index("Station")
    out = {}
    for j, h in enumerate(head):
        m = re.match(r"(\d{4})\s*-\s*(.+)", h)
        if not m:
            continue
        what = m.group(2).lower()
        kind = "total" if "total" in what else "fatal" if what.startswith("fatal") else None
        if not kind:
            continue
        d = out.setdefault((int(m.group(1)), kind), {})
        for r in rows[1:]:
            name = r[st].strip() if len(r) > st else ""
            if not name or "total" in name.lower():
                continue
            v = _n(r[j]) if len(r) > j else None
            if v is not None:
                d[key(name)] = d.get(key(name), 0) + v
    return out


def tables():
    import requests
    res = json.loads(requests.get(API, timeout=120).text)["result"]["resources"]
    out = {}
    for r in res:
        if "station" not in r["name"].lower():
            continue
        out.update(parse_table(requests.get(r["url"], timeout=120).content.decode("utf-8-sig")))
    return out


def per_station(t):
    """{station key: fields} from parse_table output."""
    def mean(years, kind, s):
        v = [t[(y, kind)][s] for y in years if s in t.get((y, kind), {})]
        return sum(v) / len(v) if v else None
    out = {}
    for s in set().union(*(t.get((y, "total"), {}) for y in RECENT)):
        tot, fat, base = mean(RECENT, "total", s), mean(RECENT, "fatal", s), mean(BASE, "fatal", s)
        row = {"crashes_yr": round(tot, 1)}
        if fat is not None:
            row["fatal_yr"] = round(fat, 1)
            if base:
                row["fatal_change_pct"] = round(100 * (fat - base) / base)
        out[s] = row
    return out


def fetch():
    import duckdb
    import requests

    from pipeline.realestate.powerplants import lived_cells
    from pipeline.realestate.wards import closed, kml_features
    feats = kml_features(requests.get(OPENCITY + MAP, timeout=180).content.decode("utf-8-sig"))
    stats = per_station(tables())
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    try:
        con.execute("SET geometry_always_xy = true")
    except duckdb.Error:
        pass
    con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
    con.executemany("INSERT INTO w VALUES (?, ST_GeomFromGeoJSON(?))",
                    [(k, json.dumps(g)) for k, g in ((k, closed(f["geometry"])) for k, f in enumerate(feats)) if g])
    area = dict(con.execute("SELECT k, ST_Area_Spheroid(ST_MakeValid(geom)) / 1e6 FROM w").fetchall())
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", lived_cells(REGION))
    hits = con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(ST_MakeValid(w.geom), ST_Point(c.x, c.y)) GROUP BY 1").fetchall()
    rows, used = {}, set()
    for code, k in hits:
        name = feats[k]["properties"].get("PS_BOUNDName", "")
        s = stats.get(key(name))
        if not s:
            continue
        used.add(key(name))
        km2 = area.get(k) or 0
        row = {"station": re.sub(r"\s+PS$", "", name.strip()), **s}
        if km2 > 0.5:
            row["crashes_per_km2"] = round(s["crashes_yr"] / km2, 2)
            if "fatal_yr" in s:
                row["fatal_per_km2"] = round(s["fatal_yr"] / km2, 3)
        rows[code] = row
    return rows, sorted(set(stats) - used)


def cell_dataset(rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("station", "Traffic police station (2022 jurisdiction)", type="category", agg="mode"),
        FieldSpec("crashes_yr", "Road crashes a year in the jurisdiction (2023-2025)", agg="max", unit="crashes/yr", ramp="reds", higher_is="worse"),
        FieldSpec("fatal_yr", "Fatal road crashes a year in the jurisdiction (2023-2025)", agg="max", unit="crashes/yr", ramp="reds", higher_is="worse"),
        FieldSpec("crashes_per_km2", "Road crashes a year per km² of the jurisdiction", agg="mean", unit="/km²/yr", ramp="reds", higher_is="worse"),
        FieldSpec("fatal_per_km2", "Fatal road crashes a year per km² of the jurisdiction", agg="mean", unit="/km²/yr", ramp="reds", higher_is="worse"),
        FieldSpec("fatal_change_pct", "Fatal crashes 2023-2025 against 2018-2019", agg="mean", unit="%", domain=[-60, 60], ramp="diverging", higher_is="worse"),
    ]
    spec = DatasetSpec(
        id="road_crashes", title="Road crashes by traffic police station (Bengaluru, BTP)", level=LEVEL, fields=specs, group="Real estate",
        description="Bengaluru Traffic Police station-wise road crash counts (2018-2025) given to every lived-in block of the station's "
                    "2022 jurisdiction: crashes and fatal crashes a year (2023-2025 mean), the same per km², and the change in fatal "
                    "crashes since 2018-2019. Stations opened after 2022 are added to the jurisdiction they were carved from. "
                    "Bengaluru only.",
        source="pipeline/realestate/btpcrashes.py (BTP station-wise crash tables and 2022 jurisdiction map via data.opencity.in)",
        license="Public domain (Bengaluru Traffic Police via data.opencity.in)", default_field="fatal_per_km2", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, REGION, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    rows, unused = fetch()
    print(f"{REGION}: {len(rows)} blocks in {len({r['station'] for r in rows.values()})} jurisdictions; stations without a polygon: {unused}")
    if rows:
        cell_dataset(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
