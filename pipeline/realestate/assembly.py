"""Latest assembly (MLA) election per block: party, runner-up and margin (ECI results via OpenCity, public domain).

Per lived-in L7 block (dataset ``assembly_results``), through its assembly seat (``constituencies`` dataset):

    mla_party        party that won the seat at the latest assembly election
    mla_runner_up    party that came second
    mla_margin_pct   winning margin, % of the seat's votes (NOTA included)
    mla_share_pct    winner's share of the seat's votes
    mla_year         year of that election
    mla_ac           seat number (the lens groups blocks by it)
    mla_party_id     ``PARTIES`` index of mla_party (0 for any other party), so lenses can count parties
    mp_party_id      the same index for the block's 2024 Lok Sabha winner (``elections_2024``), to spot split seats

Results files, one per state, all public domain on OpenCity: Delhi 2025, Maharashtra 2024 (Mumbai, Pune), West
Bengal 2026 (Kolkata), Tamil Nadu 2026 (Chennai), Telangana 2023 (Hyderabad) and Karnataka 2023 (Bengaluru; the
general election only, not by-elections). Only seat numbers and names, parties and votes are read; candidate names,
sex, age and caste category never are. Seats are matched by number and name, so seats of a neighbouring state that
share a number (Gurugram and Noida in the Delhi box) are left out. Where DataMeet's map has no name for a seat
(some Mumbai seats), the number alone is trusted outside the Delhi box, whose seats span three states.

    python -m pipeline.realestate.assembly --region all
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
DS = "https://data.opencity.in/dataset/"
# state -> (year, kind, URL)
SOURCES = {
    "Delhi": (2025, "eci", DS + "84334517-f663-4f28-a990-7c713be6d15c/resource/ed6201b7-c5ed-4dd3-9e43-0d8b2c1b14f3/download/3e59003e-2ba9-406c-8fa3-8db56f3d770b.csv"),
    "Maharashtra": (2024, "eci", DS + "0e9001ca-b19d-43e0-b0f5-73ed286bbacc/resource/1b620173-b21b-4a58-8304-93095429fab5/download/a6c740cd-c7c5-4d04-a88f-3835aabbe0fe.csv"),
    "West Bengal": (2026, "eci", DS + "6005aad7-34f5-4904-8109-fdda176c01b8/resource/b9efa164-cf94-4adf-a2af-d5d7ececb44a/download/wb-results-2026.csv"),
    "Tamil Nadu": (2026, "eci", DS + "8325ad4d-89b7-442c-80a6-24142868b8a3/resource/d7f9aa7b-9c7f-4e37-9a0e-423f6c7f242c/download/tn-results-2026.csv"),
    "Telangana": (2023, "tg", DS + "62ad1510-22c4-4f9f-a22c-aa5391ec89b6/resource/3632e39e-63c6-4d2f-b240-5decb915f4d0/download/detailed_results.xlsx"),
    "Karnataka": (2023, "tcpd", DS + "7c4d5e03-28b9-4e45-9916-5ae892d8fe1b/resource/d24bee34-312f-42dc-8094-8af7992fcdcc/download/ea07fb5e-fb01-427f-99f4-9ac8793ed2f4.csv"),
}
REGIONS = {"delhi": "Delhi", "mumbai": "Maharashtra", "pune": "Maharashtra", "kolkata": "West Bengal", "chennai": "Tamil Nadu",
           "hyderabad": "Telangana", "bengaluru": "Karnataka"}
NOTA = "None of the Above"
# Short labels used in the Telangana and Karnataka files -> the full names the ECI files use.
ABBR = {"BJP": "Bharatiya Janata Party", "INC": "Indian National Congress", "BHRS": "Bharat Rashtra Samithi",
        "BRS": "Bharat Rashtra Samithi", "AIMIM": "All India Majlis-E-Ittehadul Muslimeen", "JD(S)": "Janata Dal (Secular)",
        "AAAP": "Aam Aadmi Party", "BSP": "Bahujan Samaj Party", "IND": "Independent", "NOTA": NOTA}
# Fixed order: the lens mirrors it (js/urban-lenses-wards.js PARTY). Append only.
PARTIES = [
    ("Bharatiya Janata Party", "BJP"), ("Indian National Congress", "INC"), ("Aam Aadmi Party", "AAP"),
    ("All India Trinamool Congress", "AITC"), ("Dravida Munnetra Kazhagam", "DMK"),
    ("All India Anna Dravida Munnetra Kazhagam", "AIADMK"), ("Tamilaga Vettri Kazhagam", "TVK"), ("Shiv Sena", "Shiv Sena"),
    ("Shiv Sena (Uddhav Balasaheb Thackeray)", "Shiv Sena (UBT)"), ("Nationalist Congress Party", "NCP"),
    ("Nationalist Congress Party- Sharadchandra Pawar", "NCP (SP)"), ("Bharat Rashtra Samithi", "BRS"),
    ("All India Majlis-E-Ittehadul Muslimeen", "AIMIM"), ("Janata Dal (Secular)", "JD(S)"),
    ("Communist Party of India (Marxist)", "CPI(M)"), ("Samajwadi Party", "SP"), ("Independent", "Independent"),
    ("Maharashtra Navnirman Sena", "MNS"), ("Rashtriya Lok Dal", "RLD"), ("Viduthalai Chiruthaigal Katchi", "VCK"),
]


def _key(s):
    import re
    s = ABBR.get(str(s or "").strip(), str(s or "").strip())
    s = s.replace("Thackrey", "Thackeray").replace("–", "-").replace(" - ", "- ")
    return re.sub(r"[^a-z()]", "", s.lower())


_ID = {_key(full): k + 1 for k, (full, _) in enumerate(PARTIES)}


def party(s):
    """Full party name for a file's label ('BHRS' -> 'Bharat Rashtra Samithi'); spacing tidied."""
    s = " ".join(str(s or "").split())
    return ABBR.get(s, s)


def party_id(s):
    return _ID.get(_key(s), 0) if s else None


def _num(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def parse_eci(rows):
    """{ac_no: {name, cands: [(party, votes)], nota}} from ECI results rows (AC No, AC Name, Party, Total Votes)."""
    out = {}
    for r in rows:
        no, v = str(r.get("AC No") or "").strip(), _num(r.get("Total Votes"))
        if not no.isdigit() or v is None:
            continue
        add(out, int(no), r.get("AC Name"), r.get("Party"), v)
    return out


def parse_tcpd(rows, year):
    """The same from a Lokdhaba-style table (Constituency_No, Constituency_Name, Party, Votes), general election only."""
    out = {}
    for r in rows:
        if str(r.get("Year", year)) != str(year) or str(r.get("Poll_No", "0")).strip() not in ("0", ""):
            continue
        no, v = str(r.get("Constituency_No") or "").strip(), _num(r.get("Votes"))
        if no.isdigit() and v is not None:
            add(out, int(no), r.get("Constituency_Name"), r.get("Party"), v)
    return out


def parse_tg(rows):
    """The same from Telangana's detailed results sheet rows (AC NO., AC NAME, ..., PARTY, ..., TOTAL at index 11)."""
    out = {}
    for r in rows:
        if len(r) < 12 or not isinstance(r[1], (int, float)) or r[7] is None:
            continue
        v = _num(r[11])
        if v is not None:
            add(out, int(r[1]), r[2], r[7], v)
    return out


def add(out, no, name, p, votes):
    a = out.setdefault(no, {"name": str(name or "").strip(), "cands": [], "nota": 0.0})
    p = party(p)
    if p == NOTA:
        a["nota"] += votes
    else:
        a["cands"].append((p, votes))


def seat_result(a):
    """{mla_party, mla_runner_up, mla_margin_pct, mla_share_pct} for one seat."""
    c = sorted(a["cands"], key=lambda x: -x[1])
    total = sum(v for _, v in c) + a["nota"]
    if not c or not total:
        return None
    out = {"mla_party": c[0][0], "mla_share_pct": round(100 * c[0][1] / total, 1)}
    if len(c) > 1:
        out.update(mla_runner_up=c[1][0], mla_margin_pct=round(100 * (c[0][1] - c[1][1]) / total, 1))
    return out


def same(a, b):
    from pipeline.realestate.elections import best, norm
    return bool(a and b and (best(a, [(b, True)]) or norm(a).startswith(norm(b)) or norm(b).startswith(norm(a))))


MULTI_STATE = ("delhi",)


def block_rows(seat_of, results, year, mp_party=None, by_number=False):
    """{code: fields} for blocks whose seat (number, name) is in ``results`` under a matching name (or with no name,
    when ``by_number``)."""
    rows, memo = {}, {}
    for code, (no, name) in seat_of.items():
        if (no, name) not in memo:
            a = results.get(no)
            r = seat_result(a) if a and (same(name, a["name"]) or (by_number and not name)) else None
            memo[(no, name)] = dict(r, mla_year=year, mla_ac=no, mla_party_id=party_id(r["mla_party"])) if r else None
        r = memo[(no, name)]
        if r:
            row = dict(r)
            mp = (mp_party or {}).get(code)
            if mp:
                row["mp_party_id"] = party_id(mp)
            rows[code] = row
    return rows


def fetch(state):
    import requests
    year, kind, url = SOURCES[state]
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    if kind == "tg":
        import openpyxl
        ws = openpyxl.load_workbook(io.BytesIO(r.content), read_only=True).worksheets[0]
        return year, parse_tg(ws.iter_rows(min_row=5, values_only=True))
    rows = csv.DictReader(io.StringIO(r.content.decode("utf-8-sig")))
    return year, (parse_eci(rows) if kind == "eci" else parse_tcpd(rows, year))


def _column(region, ds, *keys):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    d = next(x for x in cat["datasets"] if x["id"] == ds)
    reg = next((x for x in d["regions"] if x["name"] == region), None)
    if not reg:
        return None
    t = store.read_region(CELLS, reg)
    return t.codes, [t.columns[k] for k in keys]


def cell_dataset(region, rows, state, year):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("mla_party", "Party holding the assembly seat", type="category", agg="mode"),
        FieldSpec("mla_runner_up", "Runner-up party in the assembly seat", type="category", agg="mode"),
        FieldSpec("mla_margin_pct", "Assembly winning margin", agg="mean", unit="% of votes", domain=[0, 40], ramp="viridis", higher_is=None),
        FieldSpec("mla_share_pct", "Winner's vote share in the assembly seat", agg="mean", unit="% of votes", domain=[20, 80], ramp="viridis", higher_is=None),
        FieldSpec("mla_year", "Year of the latest assembly election", agg="max", unit="year", ramp="viridis", higher_is=None),
        FieldSpec("mla_ac", "Assembly seat number", agg="min", ramp="viridis", higher_is=None),
        FieldSpec("mla_party_id", "Party holding the assembly seat (lens code)", agg="mode", ramp="viridis", higher_is=None),
        FieldSpec("mp_party_id", "Party of the 2024 Lok Sabha winner (lens code)", agg="mode", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="assembly_results", title="Assembly seat: latest MLA election", level=LEVEL, fields=specs, group="Real estate",
        description="The party holding each block's assembly seat after the latest state election, the runner-up and the "
                    "winning margin, from the Election Commission's results via data.opencity.in: Delhi 2025, Maharashtra "
                    "2024, West Bengal 2026, Tamil Nadu 2026, Telangana 2023 and Karnataka 2023. Seats are joined through the "
                    "constituencies dataset by number and name. Candidate names are not kept.",
        source="pipeline/realestate/assembly.py (ECI assembly results via OpenCity)",
        license="Public domain (Election Commission of India via data.opencity.in)", default_field="mla_party", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    cache = {}
    for region in (list(REGIONS) if a.region == "all" else a.region.split(",")):
        state = REGIONS[region]
        if state not in cache:
            cache[state] = fetch(state)
        year, results = cache[state]
        con = _column(region, "constituencies", "ac_no", "assembly")
        if not con:
            print(f"{region}: no constituencies")
            continue
        codes, (nos, names) = con
        seat_of = {c: (int(n), m or None) for c, n, m in zip(codes, nos, names) if n is not None and n == n}
        el = _column(region, "elections_2024", "mp_party")
        mp = dict(zip(el[0], el[1][0])) if el else {}
        rows = block_rows(seat_of, results, year, mp, by_number=region not in MULTI_STATE)
        seats = {r["mla_ac"] for r in rows.values()}
        print(f"{region}: {state} {year}, {len(rows)} of {len(seat_of)} blocks in {len(seats)} seats; "
              f"unknown parties {sorted({r['mla_party'] for r in rows.values() if not r['mla_party_id']})}")
        if rows:
            cell_dataset(region, rows, state, year)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
