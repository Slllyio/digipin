"""School safety preparedness by PIN code from UDISE+ 2025-26 (each school's safety and security return).

UDISE+ 2025-26 adds a school safety file to the per-district school census on data.opencity.in (public domain): for
every school, whether it has a school disaster management plan, a structural and a non-structural safety audit, CCTV,
fire extinguishers, safety and disaster training for staff and pupils, and self-defence training for girls. Schools
carry a PIN code but no coordinates, so, as in ``udise.py``, each block takes its PIN code's shares (dataset
``school_safety``, L7):

    ss_schools        schools in the PIN code with a safety return
    ss_audit_pct      share with a structural safety audit of the building
    ss_cctv_pct       share with CCTV cameras
    ss_plan_pct       share with a school disaster management plan
    ss_training_pct   share that trained staff and pupils in safety and disaster management
    ss_fire_pct       share with fire extinguishers
    ss_selfdef_pct    share of schools with girls that give them self-defence training
    ss_govt_audit_pct structural audit share among government schools

Shares count only schools that answered yes or no (code 9, not applicable, is left out). Covered: Delhi, Mumbai,
Bengaluru Urban, Pune, Chennai, Hyderabad and Kolkata districts.

    python -m pipeline.realestate.schoolsafety --region delhi,mumbai,bengaluru,pune,chennai,hyderabad,kolkata
"""
from __future__ import annotations

import argparse
import json

from pipeline.realestate.udise import API, CELLS, GOVT, LEVEL, MIN_SCHOOLS, _get, _rows, block_pins

PACKAGE = "udise-2025-26-district-level-reports"
PARTS = {"bengaluru": ("Bengaluru Urban North", "Bengaluru Urban South"), "chennai": ("Chennai",), "delhi": ("Delhi",),
         "hyderabad": ("Hyderabad",), "kolkata": ("Kolkata",), "mumbai": ("Mumbai City", "Mumbai Suburban"), "pune": ("Pune",)}
ITEMS = {"audit": "struct_safaud_yn", "cctv": "cctv_cam_yn", "plan": "sdmp_plan_yn", "training": "safty_trng_yn",
         "fire": "fire_ext_yn", "selfdef": "slfdef_grt_yn"}


def by_pin(prof, safety):
    """{pin: fields} from Profile Part 1 rows (pincode, managment) and School Safety rows."""
    info = {r["pseudocode"]: ((r.get("pincode") or "").strip(), (r.get("managment") or "").strip()) for r in prof}
    acc = {}
    for r in safety:
        pin, m = info.get(r.get("pseudocode"), ("", ""))
        if len(pin) != 6 or not pin.isdigit():
            continue
        a = acc.setdefault(pin, {"n": 0, **{k: [0, 0] for k in ITEMS}, "gaudit": [0, 0]})
        a["n"] += 1
        for k, col in ITEMS.items():
            v = (r.get(col) or "").strip()
            if v in ("1", "2"):
                a[k][0] += v == "1"
                a[k][1] += 1
                if k == "audit" and m in GOVT:
                    a["gaudit"][0] += v == "1"
                    a["gaudit"][1] += 1
    out = {}
    for pin, a in acc.items():
        if a["n"] < MIN_SCHOOLS:
            continue
        row = {"ss_schools": a["n"]}
        for k in (*ITEMS, "gaudit"):
            yes, n = a[k]
            if n >= MIN_SCHOOLS:
                row["ss_govt_audit_pct" if k == "gaudit" else f"ss_{k}_pct"] = round(100 * yes / n)
        out[pin] = row
    return out


def fetch_city(region):
    res = {r["name"].strip(): r["url"] for r in json.loads(_get(API + PACKAGE))["result"]["resources"]}
    prof, safety = [], []
    for part in PARTS[region]:
        prof += _rows(_get(res[f"{part} Profile Part 1"]))
        safety += _rows(_get(res[f"{part} School Safety"]))
    return by_pin(prof, safety)


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pct = lambda key, label, better="better": FieldSpec(key, label, agg="mean", unit="%", domain=[0, 100], ramp="greens", higher_is=better)
    specs = [
        pct("ss_audit_pct", "Schools with a structural safety audit (share, PIN code)"),
        pct("ss_cctv_pct", "Schools with CCTV (share, PIN code)"),
        pct("ss_plan_pct", "Schools with a disaster management plan (share, PIN code)"),
        pct("ss_training_pct", "Schools that ran safety and disaster training (share, PIN code)"),
        pct("ss_fire_pct", "Schools with fire extinguishers (share, PIN code)"),
        pct("ss_selfdef_pct", "Schools with girls giving them self-defence training (share, PIN code)"),
        pct("ss_govt_audit_pct", "Government schools with a structural safety audit (share, PIN code)"),
        FieldSpec("ss_schools", "Schools with a UDISE+ safety return in the PIN code", agg="max", unit="schools", ramp="blues", higher_is=None),
    ]
    spec = DatasetSpec(
        id="school_safety", title="School safety preparedness by PIN code (UDISE+ 2025-26)", level=LEVEL, fields=specs, group="Real estate",
        description="Share of schools in the PIN code with a structural safety audit, CCTV, a disaster management plan, safety "
                    "training, fire extinguishers and self-defence training for girls, from each school's UDISE+ 2025-26 safety "
                    "return (Ministry of Education school census, district files on data.opencity.in). Schools have PIN codes but no "
                    "coordinates, so values are PIN-code wide. Delhi, Mumbai, Bengaluru Urban, Pune, Chennai, Hyderabad and Kolkata.",
        source="pipeline/realestate/schoolsafety.py (UDISE+ 2025-26 via OpenCity; PIN codes from the neighbourhoods dataset)",
        license="Public domain (UDISE+, Ministry of Education, via data.opencity.in)", default_field="ss_audit_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default=",".join(PARTS))
    for r in ap.parse_args(argv).region.split(","):
        pins = fetch_city(r)
        rows = {c: pins[p] for c, p in block_pins(r).items() if p in pins}
        n = sum(x["ss_schools"] for x in pins.values())
        audit = [x["ss_audit_pct"] * x["ss_schools"] for x in pins.values() if "ss_audit_pct" in x]
        print(f"{r}: {len(pins)} PIN codes, {n} schools, audit share {sum(audit) / max(n, 1):.0f}%; {len(rows)} blocks matched")
        if rows:
            cell_dataset(r, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
