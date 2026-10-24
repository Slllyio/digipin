"""Pedestrian crossing gaps: how far you walk along a main road before you can cross it.

Main roads are Overture Maps trunk, primary and secondary roads (and their
links) plus tertiary roads the demand model loads with BUSY_PCU+ at peak
(motorways are access-controlled and left out). A crossing opportunity is
any junction where a third road or path meets the main road (an at-grade
junction, an underpass or bridge ramp) or a mapped crosswalk (Overture
footway/crosswalk). Main-road pieces are chained through every connector
that is not a crossing; a chain's length is the gap a pedestrian faces.
IRC 103-2022 asks for a crossing every 80–250 m in busy urban areas; GAP_M
(500 m) is used as the "too far" line. Per L7 cell (dataset ``crossings``):

    max_gap_m    longest uncrossable stretch of main road through the cell
    gap_km       main-road length in the cell on stretches longer than GAP_M
    main_km      main-road length in the cell
    crosswalks   mapped crosswalks in the cell

summary.json ``crossings``: km of main road, share on long gaps, median gap.

    python -m pipeline.traffic.crossings --region delhi
"""
from __future__ import annotations

import argparse
import bisect
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.traffic import cycling as cy
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
GAP_M = 500.0
MAIN = {"trunk", "primary", "secondary"}
MAYBE = {"tertiary"}
SKIP = {"motorway"}


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def degrees(segments):
    """Incidences per connector: 1 for a segment end, 2 for a connector inside a segment."""
    deg = Counter()
    for _, _, cons in segments:
        for c, at in cons:
            deg[c] += 1 if at <= 0 or at >= 1 else 2
    return deg


def gap_runs(segments, lengths):
    """Chain main-road pieces through non-crossing connectors.

    ``segments`` = [(is_main, is_crosswalk, [(connector_id, at)…])],
    ``lengths`` = segment lengths in metres. Returns {(si, pi): run length m}
    for every main-road piece.
    """
    deg = degrees(segments)
    cross = {c for c, d in deg.items() if d >= 3}
    for main, cw, cons in segments:
        if cw:
            cross.update(c for c, _ in cons)
    d = cy.DSU()
    plen = {}
    at_conn = defaultdict(list)
    for si, (main, _, cons) in enumerate(segments):
        if not main:
            continue
        for pi, (a0, a1, a, b) in enumerate(cy.pieces(cons)):
            key = (si, pi)
            d.find(key)
            plen[key] = (a1 - a0) * lengths[si]
            for c in (a, b):
                if c not in cross:
                    at_conn[c].append(key)
    for keys in at_conn.values():
        for k in keys[1:]:
            d.union(keys[0], k)
    run = Counter()
    for k, L in plen.items():
        run[d.find(k)] += L
    return {k: run[d.find(k)] for k in plen}


# ── IO ──────────────────────────────────────────────────────────────────────

def fetch(region, release=cy.OVERTURE_RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; INSTALL spatial; LOAD spatial;")
    base = f"s3://overturemaps-us-west-2/release/{release}"
    rows = con.execute(f"""
        SELECT class, subclass, connectors, ST_AsText(geometry)
        FROM read_parquet('{base}/theme=transportation/type=segment/*')
        WHERE subtype = 'road' AND bbox.xmin <= {e} AND bbox.xmax >= {w}
          AND bbox.ymin <= {n} AND bbox.ymax >= {s}
    """).fetchall()
    out = []
    for cls, sub, cons, wkt in rows:
        if not wkt or not wkt.startswith("LINESTRING") or not cons:
            continue
        pts = [tuple(map(float, p.split()[:2])) for p in wkt[wkt.index("(") + 1:-1].split(",")]
        out.append((cls, sub, [(c["connector_id"], float(c["at"])) for c in cons], pts))
    return out


def compute(region, segs, log=print):
    tl = dm._read("traffic_load", region)
    busy = {c for c, p in zip(tl.codes, tl.columns["peak_pcu"]) if p and p >= cy.BUSY_PCU} if tl is not None else set()

    def is_main(cls, pts):
        if cls in MAIN:
            return True
        if cls in MAYBE:
            x, y = pts[len(pts) // 2]
            return cy._cell(x, y) in busy
        return False

    flags = [(is_main(cls, pts), cls == "footway" and sub == "crosswalk") for cls, sub, _, pts in segs]
    lengths = [sum(dm.haversine_m(*a, *b) for a, b in zip(pts, pts[1:])) for *_, pts in segs]
    runs = gap_runs([(m and seg[0] not in SKIP, cw, seg[2]) for (m, cw), seg in zip(flags, segs)], lengths)
    max_gap, gap_km, main_km, cw_n = Counter(), Counter(), Counter(), Counter()
    for si, (cls, sub, cons, pts) in enumerate(segs):
        main, cw = flags[si]
        if cw:
            x, y = pts[len(pts) // 2]
            c = cy._cell(x, y)
            if c:
                cw_n[c] += 1
        if not main or cls in SKIP:
            continue
        ps = cy.pieces(cons)
        starts = [p[0] for p in ps]
        for x, y, t, m in cy.walk_line(pts):
            c = cy._cell(x, y)
            if not c:
                continue
            pi = max(0, min(len(ps) - 1, bisect.bisect_right(starts, t) - 1))
            g = runs.get((si, pi), 0)
            main_km[c] += m / 1000
            if g > max_gap[c]:
                max_gap[c] = g
            if g > GAP_M:
                gap_km[c] += m / 1000
    rows = {}
    for c in set(main_km) | set(cw_n):
        r = {}
        if main_km[c]:
            r.update(max_gap_m=round(max_gap[c]), gap_km=round(gap_km[c], 2), main_km=round(main_km[c], 2))
        if cw_n[c]:
            r["crosswalks"] = cw_n[c]
        rows[c] = r
    tot = sum(main_km.values()) or 1
    run_lengths = sorted(set(round(v) for v in runs.values()))
    summ = {"main_km": round(tot), "pct_main_km_on_long_gaps": round(100 * sum(gap_km.values()) / tot, 1),
            "median_gap_m": round(statistics.median(run_lengths)) if run_lengths else None,
            "crosswalks_mapped": sum(cw_n.values()), "gap_threshold_m": GAP_M,
            "source": f"Overture Maps transportation {cy.OVERTURE_RELEASE}"}
    log(f"{region}: {len(segs)} segments, {json.dumps(summ)}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("max_gap_m", "Longest main-road stretch with no crossing", agg="max", unit="m",
                  domain=[0, 1500], ramp="heat", higher_is="worse"),
        FieldSpec("gap_km", f"Main road on stretches over {int(GAP_M)} m without a crossing", agg="sum", unit="km",
                  ramp="reds", higher_is="worse"),
        FieldSpec("main_km", "Main-road length", agg="sum", unit="km", ramp="heat"),
        FieldSpec("crosswalks", "Mapped crosswalks", agg="sum", unit="crossings", ramp="greens", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="crossings", title="Pedestrian crossing gaps", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="How far a pedestrian walks along a main road (trunk, primary, secondary, busy tertiary) before "
                    "a junction or mapped crosswalk lets them cross: Overture Maps road segments chained through "
                    f"connectors that no other road or path meets. Stretches over {int(GAP_M)} m are gaps "
                    "(IRC 103 asks for a crossing every 80–250 m in busy areas). Mapped crosswalks are sparse in "
                    "India, so gaps count junctions as crossings and are a lower bound on the walk.",
        source=f"pipeline/traffic/crossings.py over Overture Maps transportation {cy.OVERTURE_RELEASE}",
        license="ODbL (Overture transportation, from OpenStreetMap)",
        default_field="max_gap_m", extrude=False)
    clean = ({"digipin": c, **r} for c, r in rows.items())
    table = store.bin_records(clean, LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    segs = fetch(region)
    if not segs:
        log(f"{region}: no Overture roads, skipped")
        return None
    rows, summ = compute(region, segs, log)
    res = cell_dataset(region, rows)
    path = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(path.read_text()) if path.exists() else {}
    s["crossings"] = summ
    path.write_text(json.dumps(s, indent=2) + "\n")
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    for r in (list(CITY_PILOTS) if a.region == "all" else a.region.split(",")):
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
