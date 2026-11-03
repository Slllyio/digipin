"""Who holds the municipal ward: corporation election results per ward (State Election Commissions via OpenCity, public domain).

Per lived-in L7 block (dataset ``ward_results``):

    corp_party_id     the party holding most of the ward's council seats (lens code, assembly.PARTIES order; 0 other)
    corp_party        that party's short name
    corp_seats        council seats in the ward;  corp_lead_seats  seats the leading party holds
    corp_margin_pct   winner's margin over the runner-up, % of valid votes (single-member wards)
    corp_turnout_pct  turnout, % of electors (where the results give it)
    corp_ward_no      the ward (prabhag) number on the election's map;  corp_year  the election year

Cities:

    pune       PMC 2026 (41 four- and five-member prabhags), joined through PMC's 2025 electoral ward map (OpenCity)
    hyderabad  GHMC 2020 (150 wards), joined through the ``wards`` dataset (GHMC 2022 map, same 150 wards; names agree)

Only ward numbers, parties and vote counts are read; candidate names, relatives, age, gender, category and education
columns are not.

    python -m pipeline.realestate.corporators --region pune,hyderabad
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
OC = "https://data.opencity.in/dataset/"
PUNE_RESULTS = OC + "bab43521-68f4-4909-a9c0-7dac9bf164f2/resource/ac74e3a3-0fce-4ce5-bcdf-b3b6271ae722/download/pmc-election-results.csv"
PUNE_MAP = "pune-wards-info"
# Labels in the municipal files -> the names assembly.PARTIES uses.
LABELS = {"BJP": "Bharatiya Janata Party", "INC": "Indian National Congress", "NCP": "Nationalist Congress Party",
          "NCP-SP": "Nationalist Congress Party- Sharadchandra Pawar", "SHS": "Shiv Sena",
          "SHS (UBT)": "Shiv Sena (Uddhav Balasaheb Thackeray)", "MNS": "Maharashtra Navnirman Sena",
          "TRS": "Bharat Rashtra Samithi", "BRS": "Bharat Rashtra Samithi", "AIMIM": "All India Majlis-E-Ittehadul Muslimeen",
          "IND": "Independent"}


def _f(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None


def short(label):
    from pipeline.realestate.assembly import PARTIES, party_id
    full = LABELS.get(str(label).strip(), str(label).strip())
    k = party_id(full)
    return (PARTIES[k - 1][1] if k else str(label).strip()), (k or 0)


def summarise(seats):
    """Ward fields from its seats' winning parties (multi-member wards: the party with most seats, first-listed on a tie)."""
    count = {}
    for p in seats:
        count[p] = count.get(p, 0) + 1
    lead = max(count, key=lambda p: (count[p], -seats.index(p)))
    name, pid = short(lead)
    return {"corp_party": name, "corp_party_id": pid, "corp_seats": len(seats), "corp_lead_seats": count[lead]}


def pune_wards(rows):
    """{ward no: fields} from PMC's results (Ward No. blank on the B-D seat rows; the number carries down)."""
    seats, cur = {}, None
    for r in rows:
        if str(r.get("Ward No.") or "").strip():
            cur = int(float(r["Ward No."]))
        if cur is not None and (r.get("Party") or "").strip():
            seats.setdefault(cur, []).append(r["Party"].strip())
    return {w: dict(summarise(s), corp_ward_no=w, corp_year=2026) for w, s in seats.items()}


def ghmc_wards(rows):
    """{ward no: fields} from the GHMC 2020 candidate-level results (winner, margin over the runner-up, turnout)."""
    by = {}
    for r in rows:
        w, pos = str(r.get("Ward_No") or "").strip(), str(r.get("Position") or "").strip()
        if w.isdigit() and pos in ("1", "2"):
            by.setdefault(int(w), {})[pos] = r
    out = {}
    for w, d in by.items():
        if "1" not in d:
            continue
        win = d["1"]
        f = dict(summarise([win["Party_Abbreviation"]]), corp_ward_no=w, corp_year=2020)
        valid, v1 = _f(win.get("Valid_Votes")), _f(win.get("Votes"))
        v2 = _f(d["2"].get("Votes")) if "2" in d else 0
        if valid and v1 is not None and v2 is not None:
            f["corp_margin_pct"] = round(100 * (v1 - v2) / valid, 1)
        t = _f(win.get("Voter_Turnout_Percentage"))
        if t is not None:
            f["corp_turnout_pct"] = round(t, 1)
        out[w] = f
    return out


def pune_map_rows(region, wards):
    """{code: fields} for lived-in blocks inside PMC's 2025 electoral ward map (prabhag number in field 'qwr')."""
    import duckdb
    import requests
    from pipeline.realestate.powerplants import lived_cells
    from pipeline.realestate.wards import closed, kml_features
    res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": PUNE_MAP}, timeout=60).json()["result"]["resources"]
    url = next(r["url"] for r in res if r["name"] == "PMC Electoral Wards 2025")
    feats = kml_features(requests.get(url, timeout=180).content.decode("utf-8-sig"))
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("CREATE TABLE w (k INTEGER, geom GEOMETRY)")
    con.executemany("INSERT INTO w VALUES (?, ST_GeomFromGeoJSON(?))",
                    [(int(float(f["properties"]["qwr"])), json.dumps(g)) for f in feats if (g := closed(f["geometry"]))])
    con.execute("CREATE TABLE c (code VARCHAR, y DOUBLE, x DOUBLE)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?)", list(lived_cells(region)))
    hits = con.execute("SELECT c.code, min(w.k) FROM c JOIN w ON ST_Contains(ST_MakeValid(w.geom), ST_Point(c.x, c.y)) GROUP BY 1").fetchall()
    return {code: wards[k] for code, k in hits if k in wards}


def ward_rows(region, wards):
    """{code: fields} through the ``wards`` dataset's ward numbers."""
    from pipeline.realestate.assembly import _column
    codes, (nos,) = _column(region, "wards", "ward_no")
    return {c: wards[int(n)] for c, n in zip(codes, nos) if n and str(n).isdigit() and int(n) in wards}


def cell_dataset(region, rows):
    from pipeline.cells import store
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    specs = [
        FieldSpec("corp_party", "Party holding most of the ward's council seats", type="category", agg="mode"),
        FieldSpec("corp_party_id", "Party holding the ward (lens code)", agg="mode", ramp="viridis", higher_is=None),
        FieldSpec("corp_seats", "Council seats in the ward", agg="max", unit="seats", ramp="viridis", higher_is=None),
        FieldSpec("corp_lead_seats", "Seats the leading party holds in the ward", agg="max", unit="seats", ramp="viridis", higher_is=None),
        FieldSpec("corp_margin_pct", "Ward winning margin", agg="mean", unit="% of votes", domain=[0, 50], ramp="viridis", higher_is=None),
        FieldSpec("corp_turnout_pct", "Ward election turnout", agg="mean", unit="%", domain=[20, 70], ramp="viridis", higher_is=None),
        FieldSpec("corp_ward_no", "Ward (prabhag) number on the election map", agg="min", ramp="viridis", higher_is=None),
        FieldSpec("corp_year", "Year of the municipal election", agg="max", unit="year", ramp="viridis", higher_is=None),
    ]
    spec = DatasetSpec(
        id="ward_results", title="Ward councillors' party (municipal elections)", level=LEVEL, fields=specs, group="Real estate",
        description="The party holding each block's municipal ward after the latest corporation election with a public result file "
                    "and a matching ward map: Pune (PMC 2026, four- and five-member prabhags on PMC's 2025 ward map) and "
                    "Hyderabad (GHMC 2020, with margins and turnout). From the State Election Commissions via data.opencity.in. "
                    "Candidate names and personal details are not kept.",
        source="pipeline/realestate/corporators.py (PMC 2026 and GHMC 2020 results via OpenCity)",
        license="Public domain (State Election Commissions via data.opencity.in)", default_field="corp_party", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    return store.write_dataset(CELLS, spec, region, store.bin_records(clean, LEVEL, specs), parquet=False)


def fetch_csv(url):
    import requests
    return list(csv.DictReader(io.StringIO(requests.get(url, timeout=180).content.decode("utf-8-sig"))))


def main(argv=None):
    import requests
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", default="pune,hyderabad")
    for region in ap.parse_args(argv).region.split(","):
        if region == "pune":
            wards = pune_wards(fetch_csv(PUNE_RESULTS))
            rows = pune_map_rows(region, wards)
        elif region == "hyderabad":
            res = requests.get("https://data.opencity.in/api/3/action/package_show", params={"id": "hyderabad-ghmc-elections-data"}, timeout=60).json()["result"]["resources"]
            wards = ghmc_wards(fetch_csv(res[0]["url"]))
            rows = ward_rows(region, wards)
        else:
            print(f"{region}: no ward results with a matching map")
            continue
        by = {}
        for w in wards.values():
            by[w["corp_party"]] = by.get(w["corp_party"], 0) + 1
        print(f"{region}: {len(wards)} wards {dict(sorted(by.items(), key=lambda x: -x[1]))}, {len(rows)} blocks, "
              f"{len({r['corp_ward_no'] for r in rows.values()})} wards mapped")
        cell_dataset(region, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
