"""School quality by PIN code from UDISE+ 2024-25 (every school's profile, rooms, toilets and teachers).

Per L7 block (dataset ``schools_udise``), the values of the block's PIN code (from the neighbourhoods dataset):

    schools            UDISE+ schools in the PIN code
    govt_pct           share of them run by government (education department, local body, other departments, central)
    pupils_per_teacher pupils per teacher in government schools (RTE norm: 30 primary, 35 upper primary)
    govt_pupils        pupils enrolled in government schools
    repair_pct         government classrooms needing major repair (%)
    girls_toilet_pct   government schools with a working girls' toilet (%)
    library_pct        government schools with a library (%)
    private_pct        share run as private unaided schools

UDISE+ school-level files are published per district on data.opencity.in (public domain); schools carry a PIN code
but no coordinates, so the PIN code is the finest join. Covered: Delhi, Bengaluru Urban, Chennai, Hyderabad and
Kolkata districts. A PIN code spans several square kilometres, so read these as the neighbourhood's school picture.

    python -m pipeline.realestate.udise --region delhi,bengaluru,chennai,hyderabad,kolkata
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
API = "https://data.opencity.in/api/3/action/package_show?id="
PACKAGES = {
    "delhi": ["delhi-udise-2024-25"],
    "bengaluru": ["bengaluru-urban-udise-2024-25"],
    "chennai": ["chennai-udise-2024-25"],
    "hyderabad": ["hyderabad-udise-2024-25"],
    "kolkata": ["kolkata-udise-2024-25"],
}
FALLBACK = {"bengaluru-urban-udise-2024-25": "bengaluru-urban-udise-2023-24"}   # its South 'Profile Part 1' links Part 2
# UDISE+ management codes run by government: education dept, tribal/social welfare, local body, other govt, central govt
GOVT = {"1", "2", "3", "6", "89", "90", "91", "92", "93", "94", "95", "96", "101"}
PRIVATE = {"5"}
MIN_SCHOOLS = 3


def _get(url):
    import requests
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    return r.content.decode("utf-8-sig", errors="replace")


def _rows(text):
    return list(csv.DictReader(io.StringIO(text)))


def resources(package):
    """{(part, kind): url} where part is the resource-name prefix ('Delhi', 'Bengaluru Urban North') and kind one of
    prof1, fac, enr1, tch."""
    out = {}
    kinds = {"Profile Part 1": "prof1", "Facilities": "fac", "Enrolment Data Part 1": "enr1", "Teachers Data": "tch"}
    for r in json.loads(_get(API + package))["result"]["resources"]:
        for label, k in kinds.items():
            if r["name"].strip().endswith(label):
                out[(r["name"].strip()[: -len(label)].strip(), k)] = r["url"]
    return out


def _n(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def by_pin(prof, fac, enr, tch):
    """{pin: fields} from UDISE+ rows (lists of dicts keyed by column)."""
    pupils = {}
    for r in enr:
        if r.get("item_group") == "1":
            pupils[r["pseudocode"]] = pupils.get(r["pseudocode"], 0) + sum(_n(v) for k, v in r.items() if k.startswith(("c", "cpp")) and k[-2:] in ("_b", "_g"))
    teachers = {r["pseudocode"]: _n(r.get("total_tch")) for r in tch}
    facs = {r["pseudocode"]: r for r in fac}
    acc = {}
    for r in prof:
        pin = (r.get("pincode") or "").strip()
        if len(pin) != 6 or not pin.isdigit():
            continue
        a = acc.setdefault(pin, {"n": 0, "govt": 0, "priv": 0, "gp": 0.0, "gt": 0.0, "rooms": 0.0, "repair": 0.0, "girls": 0, "girls_n": 0, "lib": 0})
        a["n"] += 1
        m = (r.get("managment") or "").strip()
        a["priv"] += m in PRIVATE
        if m not in GOVT:
            continue
        a["govt"] += 1
        sc = r["pseudocode"]
        a["gp"] += pupils.get(sc, 0)
        a["gt"] += teachers.get(sc, 0)
        f = facs.get(sc)
        if f:
            a["rooms"] += _n(f.get("total_class_rooms"))
            a["repair"] += _n(f.get("classrooms_needs_major_repair"))
            a["girls_n"] += 1
            a["girls"] += _n(f.get("total_girls_func_toilet")) > 0
            a["lib"] += f.get("library_availability") == "1"
    out = {}
    for pin, a in acc.items():
        if a["n"] < MIN_SCHOOLS:
            continue
        row = {"schools": a["n"], "govt_pct": round(100 * a["govt"] / a["n"]), "private_pct": round(100 * a["priv"] / a["n"])}
        if a["govt"]:
            row["govt_pupils"] = round(a["gp"])
            if a["gt"]:
                row["pupils_per_teacher"] = round(a["gp"] / a["gt"], 1)
            if a["rooms"]:
                row["repair_pct"] = round(100 * a["repair"] / a["rooms"], 1)
            if a["girls_n"]:
                row["girls_toilet_pct"] = round(100 * a["girls"] / a["girls_n"])
                row["library_pct"] = round(100 * a["lib"] / a["girls_n"])
        out[pin] = row
    return out


def fetch_city(region):
    prof, fac, enr, tch = [], [], [], []
    for pkg in PACKAGES[region]:
        res = resources(pkg)
        old = resources(FALLBACK[pkg]) if pkg in FALLBACK else {}
        for (part, kind), url in res.items():
            rows = _rows(_get(url))
            if kind == "prof1" and rows and "pincode" not in rows[0] and (part, "prof1") in old:
                rows = _rows(_get(old[(part, "prof1")]))        # pseudocodes are stable across years
            {"prof1": prof, "fac": fac, "enr1": enr, "tch": tch}[kind].extend(rows)
    return by_pin(prof, fac, enr, tch)


def block_pins(region):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "neighbourhoods")
    t = store.read_region(CELLS, next(r for r in ds["regions"] if r["name"] == region))
    return {c: p for c, p in zip(t.codes, t.columns["pin"]) if p}


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("schools", "UDISE+ schools in the PIN code", agg="max", unit="schools", ramp="blues", higher_is="better"),
        FieldSpec("govt_pct", "Government schools (share)", agg="mean", unit="%", domain=[0, 100], ramp="blues"),
        FieldSpec("private_pct", "Private unaided schools (share)", agg="mean", unit="%", domain=[0, 100], ramp="purples"),
        FieldSpec("govt_pupils", "Pupils in government schools in the PIN code", agg="max", unit="pupils", ramp="blues"),
        FieldSpec("pupils_per_teacher", "Pupils per teacher, government schools", agg="mean", unit="pupils", ramp="reds", higher_is="worse"),
        FieldSpec("repair_pct", "Government classrooms needing major repair", agg="mean", unit="%", domain=[0, 50], ramp="reds", higher_is="worse"),
        FieldSpec("girls_toilet_pct", "Government schools with a working girls' toilet", agg="mean", unit="%", domain=[0, 100], ramp="greens", higher_is="better"),
        FieldSpec("library_pct", "Government schools with a library", agg="mean", unit="%", domain=[0, 100], ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="schools_udise", title="Schools by PIN code (UDISE+ 2024-25)", level=LEVEL, fields=specs, group="Real estate",
        description="Every school in UDISE+ 2024-25 (the Ministry of Education's school census) summed by PIN code and given to each "
                    "block in that PIN code: school count, government and private shares, pupils per teacher, classrooms needing "
                    "major repair, working girls' toilets and libraries in government schools. School files come per district from "
                    "data.opencity.in; schools have PIN codes but no coordinates, so values are PIN-code wide. Delhi, Bengaluru Urban, "
                    "Chennai, Hyderabad and Kolkata districts only.",
        source="pipeline/realestate/udise.py (UDISE+ via OpenCity; PIN codes from the neighbourhoods dataset)",
        license="Public domain (UDISE+, Ministry of Education, via data.opencity.in)", default_field="pupils_per_teacher", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(PACKAGES))
    a = ap.parse_args(argv)
    for r in a.region.split(","):
        pins = fetch_city(r)
        rows = {c: pins[p] for c, p in block_pins(r).items() if p in pins}
        print(f"{r}: {len(pins)} PIN codes with {sum(x['schools'] for x in pins.values())} schools; {len(rows)} blocks matched")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
