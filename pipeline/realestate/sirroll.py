"""Voter roll revision 2026: electors per assembly seat after the Special Intensive Revision (ECI via OpenCity, public domain).

The Election Commission's Special Intensive Revision (SIR) re-verified every elector in West Bengal and Tamil Nadu
(rolls final early 2026) and Karnataka (final October 2026). OpenCity publishes the seat-wise counts. Each lived-in
L7 block gets its assembly seat's figures (dataset ``roll_revision``), joined through the ``constituencies`` dataset
by number and name:

    sir_electors          electors on the final 2026 roll
    sir_electors_2024     electors at the 2024 Lok Sabha election (ECI assembly-segment table)
    sir_change_pct        change from 2024 to the final 2026 roll (%)
    sir_women_per_1000    women per 1,000 men on the final roll
    sir_draft_change_pct  West Bengal: change from the January 2026 draft roll to the final roll (%)
    sir_deleted_pct       Tamil Nadu: electors struck off at the draft stage, % of the roll before the revision
    sir_dead_pct / sir_shifted_pct / sir_multiple_pct   Tamil Nadu: those deletions by reason (dead, shifted or
                          absent, enrolled in more than one place), % of the roll before the revision
    sir_notice_pct        Karnataka: electors sent a notice to prove eligibility, % of the final roll
    sir_ineligible        Karnataka: electors the registration officer marked ineligible on a Form 7 objection

Only counts are read; the rolls themselves (names and addresses) are not.

    python -m pipeline.realestate.sirroll --region bengaluru,kolkata,chennai
"""
from __future__ import annotations

import argparse
import csv
import io
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OC = "https://data.opencity.in/dataset/"
KA = OC + "51e6e2e7-8e40-4006-808e-fd2d652b6e74/resource/"
WB = OC + "f534b035-5e5f-4b2d-bd48-b0549a7d222b/resource/"
TN = OC + "0b5df931-c21e-4199-8386-3259d7917152/resource/"
SOURCES = {
    "Karnataka": {"final": KA + "e33c55f3-495d-41bc-9e54-f6df125d86a2/download/annexure-1-general-electors.csv",
                  "notices": KA + "6128b6cb-c609-4fbe-8f0c-58c32c404757/download/annexure-9-disposal-of-notices.csv"},
    "West Bengal": {"final": WB + "f7c67499-5830-4991-b724-3e796b634ef9/download/wb_acwise_elector_2026.csv",
                    "draft": WB + "c7cb58ef-4267-4386-8ab5-5a014078999c/download/wb-sir-draft-rolls-2026.csv"},
    "Tamil Nadu": {"final": TN + "4118b407-3ed4-4a9f-b0f0-143009c90518/download/tn_acwise_gendercount.csv",
                   "draft": TN + "b6d380ab-5f03-45ad-b4cf-c1459dab9414/download/tn_elector_rolls_19022025.csv",
                   "deleted": TN + "d1724441-e1ca-4edc-b011-3681553d477a/download/chennai-sir-additions-deletions-2026.csv"},
}
REGIONS = {"bengaluru": "Karnataka", "kolkata": "West Bengal", "chennai": "Tamil Nadu"}


def _num(x):
    x = str(x or "").replace(",", "").strip()
    return int(x) if x.isdigit() else None


def _get(r, *names):
    """First present column among ``names`` (headers differ between the states' files)."""
    low = {k.strip().lower(): v for k, v in r.items() if k}
    return next((low[n.lower()] for n in names if n.lower() in low), None)


def roll(rows):
    """{AC number: {name, total, male, female}} from a seat-wise roll table; district and state total rows are skipped."""
    out = {}
    for r in rows:
        no = _num(_get(r, "ac_no", "AC No.", "AC NO"))
        total = _num(_get(r, "total", "Total", "Total electors", "District Total"))
        if no is None or total is None or (_get(r, "row_type") or "AC").strip() != "AC":
            continue
        out[no] = {"name": (_get(r, "ac_name", "AC Name", "AC name", "Name of Assembly Constituency") or "").strip(),
                   "total": total, "male": _num(_get(r, "male", "Male electors")), "female": _num(_get(r, "female", "Female electors"))}
    return out


def deletions(rows):
    """{AC number: (dead, shifted or absent, multiple, total)} from Tamil Nadu's draft-stage deletions table."""
    out = {}
    for r in rows:
        no = _num(str(_get(r, "No and Name of the AC") or "").split("-")[0])
        vals = [_num(_get(r, c)) for c in ("Deceased", "Shifted/ Absent", "Enrolled at multiple places", "Total")]
        if no is not None and None not in vals:
            out[no] = tuple(vals)
    return out


def notices(rows):
    """{AC number: (notices generated, marked ineligible)} from Karnataka's disposal-of-notices table."""
    out = {}
    for r in rows:
        no = _num(r.get("ac_no"))
        if no is not None and (r.get("row_type") or "").strip() == "AC":
            out[no] = (_num(r.get("notices_generated")) or 0, _num(r.get("form7_raised_electors_marked_ineligible_by_ero")) or 0)
    return out


def seat_figures(state, tables, e2024):
    """{AC number: (name, {field: value})} for a state's seats; ``e2024`` is {AC number: 2024 electors}."""
    pct = lambda a, b: round(100 * a / b, 2) if b else None
    out = {}
    for no, f in tables["final"].items():
        x = {"sir_electors": f["total"]}
        if f["male"] and f["female"]:
            x["sir_women_per_1000"] = round(1000 * f["female"] / f["male"])
        if e2024.get(no):
            x["sir_electors_2024"] = e2024[no]
            x["sir_change_pct"] = round(pct(f["total"], e2024[no]) - 100, 1)
        draft = tables.get("draft", {}).get(no)
        dl = tables.get("deleted", {}).get(no)
        if dl and draft:                     # Tamil Nadu: the roll before revision is the draft plus what it struck off
            before = draft["total"] + dl[3]
            x.update(sir_deleted_pct=round(pct(dl[3], before), 1), sir_dead_pct=round(pct(dl[0], before), 1),
                     sir_shifted_pct=round(pct(dl[1], before), 1), sir_multiple_pct=round(pct(dl[2], before), 1))
        elif draft:
            x["sir_draft_change_pct"] = round(pct(f["total"], draft["total"]) - 100, 1)
        nt = tables.get("notices", {}).get(no)
        if nt:
            x.update(sir_notice_pct=round(pct(nt[0], f["total"]), 1), sir_ineligible=nt[1])
        out[no] = (f["name"], x)
    return out


def block_rows(seat_of, figs):
    """{code: fields} for blocks whose seat (number, name) matches a seat in ``figs`` by number and name."""
    from pipeline.realestate.assembly import same
    ok = {no: f for no, (name, f) in figs.items()}
    names = {no: name for no, (name, _) in figs.items()}
    memo = {}
    rows = {}
    for code, (no, name) in seat_of.items():
        if (no, name) not in memo:
            memo[(no, name)] = no in ok and (not name or same(name, names[no].split("(")[0].strip()))
        if memo[(no, name)]:
            rows[code] = dict(ok[no], sir_ac=no)
    return rows


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    pct = lambda k, label, d, hi=None: FieldSpec(k, label, agg="mean", unit="%", domain=d, ramp="viridis", higher_is=hi)
    specs = [
        FieldSpec("sir_electors", "Electors on the seat's final 2026 roll", agg="max", unit="electors", ramp="viridis", higher_is=None),
        FieldSpec("sir_electors_2024", "Electors in the seat at the 2024 Lok Sabha election", agg="max", unit="electors", ramp="viridis", higher_is=None),
        pct("sir_change_pct", "Change in the seat's electors, 2024 to the final 2026 roll", [-30, 10]),
        FieldSpec("sir_women_per_1000", "Women per 1,000 men on the seat's final roll", agg="mean", unit="per 1,000", domain=[850, 1100], ramp="viridis", higher_is=None),
        pct("sir_draft_change_pct", "Change from the January 2026 draft roll to the final roll", [-10, 10]),
        pct("sir_deleted_pct", "Electors struck off at the draft stage, % of the roll before revision", [0, 40]),
        pct("sir_dead_pct", "Struck off as dead, % of the roll before revision", [0, 15]),
        pct("sir_shifted_pct", "Struck off as shifted or absent, % of the roll before revision", [0, 30]),
        pct("sir_multiple_pct", "Struck off as enrolled in more than one place, % of the roll before revision", [0, 5]),
        pct("sir_notice_pct", "Electors sent a notice to prove eligibility, % of the final roll", [0, 10]),
        FieldSpec("sir_ineligible", "Electors marked ineligible on a Form 7 objection", agg="max", unit="electors", ramp="reds", higher_is=None),
        FieldSpec("sir_ac", "Assembly seat number", agg="min", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="roll_revision", title="Voter roll revision (SIR 2026)", level=LEVEL, fields=specs, group="Real estate",
        description="Electors per assembly seat after the Election Commission's 2026 Special Intensive Revision, against the "
                    "2024 Lok Sabha roll: West Bengal and Tamil Nadu (final rolls early 2026, with the draft-stage deletions "
                    "by reason for Tamil Nadu) and Karnataka (final roll October 2026, with eligibility notices). Seat-wise "
                    "counts from the Chief Electoral Officers via data.opencity.in; no names or addresses are read.",
        source="pipeline/realestate/sirroll.py (CEO seat-wise SIR roll tables via OpenCity, ECI 2024 segment electors)",
        license="Public domain (Election Commission of India via data.opencity.in)", default_field="sir_change_pct", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def fetch(state):
    import requests
    get = lambda u: list(csv.DictReader(io.StringIO(requests.get(u, timeout=120).content.decode("utf-8-sig"))))
    src = SOURCES[state]
    t = {k: roll(get(src[k])) for k in ("final", "draft") if k in src}
    if "deleted" in src:
        t["deleted"] = deletions(get(src["deleted"]))
    if "notices" in src:
        t["notices"] = notices(get(src["notices"]))
    return t


def main(argv=None):
    from pipeline.realestate.assembly import _column
    from pipeline.realestate.elections import SEGMENTS, _csv, parse_segments
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="all")
    a = ap.parse_args(argv)
    segs = parse_segments(_csv(SEGMENTS))
    for region in (list(REGIONS) if a.region == "all" else a.region.split(",")):
        state = REGIONS[region]
        e2024 = {no: s["electors"] for (no, _, st), s in segs.items() if st == state and s.get("electors")}
        figs = seat_figures(state, fetch(state), e2024)
        codes, (nos, names) = _column(region, "constituencies", "ac_no", "assembly")
        seat_of = {c: (int(n), m or None) for c, n, m in zip(codes, nos, names) if n is not None and n == n}
        rows = block_rows(seat_of, figs)
        seats = sorted({r["sir_ac"] for r in rows.values()})
        ch = [figs[s][1].get("sir_change_pct") for s in seats]
        print(f"{region}: {len(rows)} of {len(seat_of)} blocks in {len(seats)} seats; change 2024->2026 "
              f"{min(c for c in ch if c is not None)}..{max(c for c in ch if c is not None)}%")
        cell_dataset(region, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
