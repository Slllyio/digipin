"""Lok Sabha 2024 results per block, through its assembly segment (ECI via OpenCity, public domain).

Per lived-in L7 block (dataset ``elections_2024``), from the block's constituencies (``constituencies`` dataset):

    mp              Lok Sabha member elected in 2024 for the block's constituency
    mp_party        their party
    pc_margin_pct   winning margin, % of the constituency's EVM votes
    turnout_pct     EVM votes polled in the block's assembly segment, % of its electors
    lead_party      party with most EVM votes in the assembly segment
    nota_pct        NOTA, % of the segment's EVM votes

Constituencies are matched by number and name (names differ in spelling across sources, e.g. "Vandre West" and
"VandreEast"), because the city regions span states (Delhi with Gurugram and Noida) and the 2008 map lists Telangana
under Andhra Pradesh. Postal ballots are not split by segment, so turnout counts EVM votes only.

    python -m pipeline.realestate.elections --region all
"""
from __future__ import annotations

import argparse
import csv
import difflib
import io
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
BASE = "https://data.opencity.in/dataset/85a345c6-78c0-4f57-adfc-236c726c5456/resource/"
WINNERS = BASE + "3e96ed32-9b97-4c5b-9201-7807d90b20e5/download/2a4e0925-0903-4857-902b-9a57cfb78094.csv"
SEGMENTS = BASE + "881d1489-a8fc-46b1-b00d-d4824e08e797/download/142dc4e5-49e3-4412-a751-d712970b0dd5.csv"
MATCH = 0.7


def norm(s):
    s = re.sub(r"\((sc|st)\)", "", (s or "").lower())
    return re.sub(r"[^a-z]", "", s)


def _n(x):
    try:
        return float(str(x).replace(",", ""))
    except ValueError:
        return 0.0


def best(name, cands):
    """The candidate (name, row) whose name is closest to ``name``, if close enough."""
    k = norm(name)
    scored = [(difflib.SequenceMatcher(None, k, norm(c)).ratio(), c, r) for c, r in cands]
    scored = [x for x in scored if x[0] >= MATCH]
    return max(scored, key=lambda x: x[0])[2] if scored else None


def parse_segments(rows):
    """{(ac_no, ac_name): {electors, votes, lead_party, nota, pc_no, pc_name}} from the ECI segment table rows."""
    acc = {}
    for r in rows:
        if len(r) < 12 or not r[4].strip().isdigit():
            continue
        key = (int(r[4]), r[5].strip(), r[0].strip())
        a = acc.setdefault(key, {"electors": _n(r[6]), "nota": _n(r[8]), "party": {}, "pc_no": int(r[1]), "pc_name": r[2].strip()})
        a["party"][r[10].strip()] = a["party"].get(r[10].strip(), 0) + _n(r[11])
    out = {}
    for (no, name, state), a in acc.items():
        votes = sum(a["party"].values()) + a["nota"]
        lead = sorted(a["party"].items(), key=lambda x: -x[1])
        out[(no, name, state)] = {"pc_no": a["pc_no"], "pc_name": a["pc_name"], "lead_party": lead[0][0] if lead else None,
                                  "turnout_pct": round(100 * votes / a["electors"], 1) if a["electors"] else None,
                                  "nota_pct": round(100 * a["nota"] / votes, 2) if votes else None, "votes": votes}
    return out


def parse_winners(rows, segs):
    """{(pc_no, pc_name, state): {mp, mp_party, pc_margin_pct}}; the margin is over the PC's EVM votes from segs."""
    pc_votes = {}
    for (_, _, state), s in segs.items():
        k = (s["pc_no"], s["pc_name"], state)
        pc_votes[k] = pc_votes.get(k, 0) + s["votes"]
    out = {}
    for r in rows:
        if len(r) < 8 or not r[1].strip().isdigit():
            continue
        k = (int(r[1]), r[2].strip(), r[0].strip())
        v = pc_votes.get(k)
        out[k] = {"mp": r[3].strip().title(), "mp_party": r[4].strip(),
                  "pc_margin_pct": round(100 * _n(r[7]) / v, 1) if v else None}
    return out


def block_rows(con_table, segs, wins):
    """{code: fields} for the blocks of one region's constituencies table (codes, columns)."""
    by_ac, by_pc = {}, {}
    for k, s in segs.items():
        by_ac.setdefault(k[0], []).append((k[1], s))
    for k, w in wins.items():
        by_pc.setdefault(k[0], []).append((k[1], w))
    cols = con_table.columns
    cache, out = {}, {}
    for i, code in enumerate(con_table.codes):
        ac, an, pc, pn = cols["ac_no"][i], cols["assembly"][i], cols["pc_no"][i], cols["lok_sabha"][i]
        key = (ac, an, pc, pn)
        if key not in cache:
            row = {}
            s = best(an, by_ac.get(int(ac), [])) if ac not in (None, "") and str(ac).isdigit() else None
            if s:
                row.update({k: s[k] for k in ("turnout_pct", "lead_party", "nota_pct") if s[k] is not None})
            w = best(pn, by_pc.get(int(pc), [])) if pc not in (None, "") and str(pc).isdigit() else None
            if w:
                row.update({k: v for k, v in w.items() if v is not None})
            cache[key] = row
        if cache[key]:
            out[code] = cache[key]
    return out


def _csv(url):
    import requests
    return list(csv.reader(io.StringIO(requests.get(url, timeout=300).content.decode("utf-8-sig"))))


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("mp", "Member of Parliament elected 2024", type="category", agg="mode"),
        FieldSpec("mp_party", "MP's party (2024)", type="category", agg="mode"),
        FieldSpec("pc_margin_pct", "Winning margin in the Lok Sabha constituency (2024)", agg="mean", unit="% of votes", ramp="viridis"),
        FieldSpec("turnout_pct", "Turnout in the assembly segment, Lok Sabha 2024 (EVM)", agg="mean", unit="%", domain=[40, 80], ramp="viridis"),
        FieldSpec("lead_party", "Party leading the assembly segment (2024)", type="category", agg="mode"),
        FieldSpec("nota_pct", "NOTA share in the assembly segment (2024)", agg="mean", unit="%", ramp="viridis"),
    ]
    spec = DatasetSpec(
        id="elections_2024", title="Lok Sabha 2024 results (ECI via OpenCity)", level=LEVEL, fields=specs, group="Real estate",
        description="Lok Sabha 2024 results joined to each block through its assembly and parliamentary constituencies "
                    "(constituencies dataset, 2008 delimitation): the elected MP and party, the winning margin, and for the "
                    "block's assembly segment the EVM turnout, leading party and NOTA share. Election Commission of India "
                    "tables via data.opencity.in.",
        source="pipeline/realestate/elections.py (ECI 2024 tables via OpenCity, matched by constituency number and name)",
        license="Public domain (Election Commission of India via data.opencity.in)", default_field="turnout_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def main(argv=None):
    from pipeline.cells import store
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    segs = parse_segments(_csv(SEGMENTS))
    wins = parse_winners(_csv(WINNERS), segs)
    cat = json.loads((CELLS / "catalog.json").read_text())
    ds = next(d for d in cat["datasets"] if d["id"] == "constituencies")
    for reg in ds["regions"]:
        if a.region != "all" and reg["name"] not in a.region.split(","):
            continue
        rows = block_rows(store.read_region(CELLS, reg), segs, wins)
        mps = {r.get("mp") for r in rows.values() if r.get("mp")}
        print(f"{reg['name']}: {len(rows)} blocks, {len(mps)} MPs")
        if rows:
            cell_dataset(reg["name"], rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
