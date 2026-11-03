"""Low-stress cycling: which streets a child or a cautious adult can ride, and where main roads cut them off.

Every Overture Maps road segment in the city is split at its connectors and
classed by Level of Traffic Stress (Mekuria, Furth & Nixon 2012), from the
road class only (open data has no lane, speed-limit or parking data):

    high stress  motorway, trunk, primary, secondary (and their links):
                 mixed traffic at arterial speeds; tertiary roads too where
                 the demand model puts BUSY_PCU+ on them at peak (traffic_load)
    low stress   residential, living street, service, unclassified, track,
                 cycleway, path, pedestrian, bridleway, quiet tertiary

A junction touched by any high-stress road is a crossing nobody cautious
rides through (no signal or crossing data), so the low-stress pieces form
"islands" bounded by the main roads. Per L7 cell (dataset ``cycling``):

    lowstress_km   low-stress street length in the cell
    cycleway_km    mapped cycle track length (class cycleway)
    highstress_km  main-road length in the cell
    island         id of the island holding most of the cell's low-stress
                   streets (1 = the largest island in the city)
    island_km2     area of that island (cells it touches × cell area)
    island_pop     residents of the cells whose main island it is
    crossing_gain  residents who would join a bigger island if the best
                   main-road junction in the cell got a safe crossing

summary.json ``cycling``: km by class, island counts, residents in islands
smaller than 1 km².

    python -m pipeline.traffic.cycling --region delhi
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS, bbox_for
from pipeline.traffic import demand_model as dm

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"
LEVEL = 7
OVERTURE_RELEASE = "2026-10-21.0"
SAMPLE_M = 50.0
SMALL_ISLAND_KM2 = 1.0
BUSY_PCU = 600                 # same threshold as the road-danger lens (js/urban-lenses-mobility.js)
HIGH = {"motorway", "trunk", "primary", "secondary"}
LOW = {"residential", "living_street", "service", "unclassified", "track", "cycleway", "path",
       "pedestrian", "bridleway"}
MAYBE = {"tertiary"}            # high when busy


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def stress(cls, busy=False):
    """'high' | 'low' | None (footways, steps, unknown: not ridden); `busy` = modelled BUSY_PCU+ at peak."""
    if cls in HIGH or (cls in MAYBE and busy):
        return "high"
    if cls in LOW or cls in MAYBE:
        return "low"
    return None


class DSU:
    def __init__(self):
        self.p = {}

    def find(self, a):
        p = self.p
        p.setdefault(a, a)
        while p[a] != a:
            p[a] = p[p[a]]
            a = p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def pieces(connectors):
    """[(at0, at1, id0, id1)] between consecutive connectors of one segment."""
    cs = sorted(connectors, key=lambda c: c[1])
    return [(a[1], b[1], a[0], b[0]) for a, b in zip(cs, cs[1:])]


def islands(segments):
    """Union the low-stress pieces into islands, never through a high-stress junction.

    ``segments`` = [(stress, [(connector_id, at)…])] with stress from
    stress(). Returns (piece_island,
    blocked) where piece_island maps (segment index, piece index) → island
    root (None for high-stress pieces) and blocked is the set of junctions
    touched by a high-stress road.
    """
    blocked = set()
    for st, cons in segments:
        if st == "high":
            blocked.update(c for c, _ in cons)
    d = DSU()
    for st, cons in segments:
        if st != "low":
            continue
        for _, _, a, b in pieces(cons):
            if a not in blocked and b not in blocked:
                d.union(a, b)
            elif a not in blocked:
                d.find(a)
            elif b not in blocked:
                d.find(b)
    out = {}
    for si, (st, cons) in enumerate(segments):
        if st != "low":
            continue
        for pi, (_, _, a, b) in enumerate(pieces(cons)):
            # A stub between two main-road junctions is its own (tiny) island.
            out[(si, pi)] = d.find(a) if a not in blocked else d.find(b) if b not in blocked else ("stub", si, pi)
    return out, blocked


def walk_line(coords, step_m=SAMPLE_M):
    """[(x, y, t, length_m)] samples along a polyline: t = fraction along it, length = metres it stands for."""
    seg = [dm.haversine_m(ax, ay, bx, by) for (ax, ay), (bx, by) in zip(coords, coords[1:])]
    total = sum(seg)
    if total <= 0:
        return []
    out, done = [], 0.0
    for ((ax, ay), (bx, by)), d in zip(zip(coords, coords[1:]), seg):
        k = max(1, int(math.ceil(d / step_m)))
        for j in range(k):
            t = (j + 0.5) / k
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t, (done + d * t) / total, d / k))
        done += d
    return out


# ── IO ──────────────────────────────────────────────────────────────────────

def fetch(region, release=OVERTURE_RELEASE):
    import duckdb
    w, s, e, n = bbox_for(region)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; INSTALL spatial; LOAD spatial;")
    base = f"s3://overturemaps-us-west-2/release/{release}"
    rows = con.execute(f"""
        SELECT class, connectors, ST_AsText(geometry)
        FROM read_parquet('{base}/theme=transportation/type=segment/*')
        WHERE subtype = 'road' AND bbox.xmin <= {e} AND bbox.xmax >= {w}
          AND bbox.ymin <= {n} AND bbox.ymax >= {s}
          AND class IN {tuple(sorted(HIGH | LOW | MAYBE))}
    """).fetchall()
    out = []
    for cls, cons, wkt in rows:
        if not wkt or not wkt.startswith("LINESTRING") or not cons:
            continue
        pts = [tuple(map(float, p.split()[:2])) for p in wkt[wkt.index("(") + 1:-1].split(",")]
        out.append((cls, [(c["connector_id"], float(c["at"])) for c in cons], pts))
    return out


def _cell(x, y):
    try:
        return digipin.encode(y, x).replace("-", "")[:LEVEL]
    except Exception:
        return None


def compute(region, segs, log=print):
    tl = dm._read("traffic_load", region)
    busy = {c for c, p in zip(tl.codes, tl.columns["peak_pcu"]) if p and p >= BUSY_PCU} if tl is not None else set()

    def seg_stress(cls, pts):
        if cls not in MAYBE:
            return stress(cls)
        x, y = pts[len(pts) // 2]
        return stress(cls, _cell(x, y) in busy)

    stresses = [seg_stress(c, pts) for c, _, pts in segs]
    piece_isl, blocked = islands([(st, k) for st, (_, k, _) in zip(stresses, segs)])
    low_km, cyc_km, high_km = Counter(), Counter(), Counter()
    by_cell = defaultdict(Counter)                     # cell → island → metres
    isl_cells = defaultdict(set)
    junction_isl = defaultdict(set)                    # blocked junction → islands touching it
    junction_xy = {}
    for si, (cls, cons, pts) in enumerate(segs):
        st = stresses[si]
        if st is None:
            continue
        ps = pieces(cons)
        starts = [p[0] for p in ps]
        for x, y, t, m in walk_line(pts):
            c = _cell(x, y)
            if not c:
                continue
            if st == "high":
                high_km[c] += m / 1000
                continue
            low_km[c] += m / 1000
            if cls == "cycleway":
                cyc_km[c] += m / 1000
            pi = max(0, min(len(ps) - 1, bisect.bisect_right(starts, t) - 1))
            isl = piece_isl.get((si, pi))
            if isl is not None:
                by_cell[c][isl] += m
                isl_cells[isl].add(c)
        if st == "low":
            for pi, (a0, a1, a, b) in enumerate(ps):
                for j, at in ((a, a0), (b, a1)):
                    if j in blocked:
                        junction_isl[j].add(piece_isl[(si, pi)])
                        if j not in junction_xy:
                            k = min(len(pts) - 1, max(0, round(at * (len(pts) - 1))))
                            junction_xy[j] = pts[k]
    pop_t = dm._read("population", region)
    pop = {c[:LEVEL]: p for c, p in zip(pop_t.codes, pop_t.columns["population"]) if p and p > 0} if pop_t else {}
    main = {c: isl.most_common(1)[0][0] for c, isl in by_cell.items()}
    isl_pop = Counter()
    for c, i in main.items():
        isl_pop[i] += pop.get(c, 0)
    any_cell = next(iter(main), None)
    if any_cell:
        b = digipin.decode_partial(any_cell)["bounds"]
        cell_km2 = dm.haversine_m(b["west"], b["south"], b["east"], b["south"]) * \
            dm.haversine_m(b["west"], b["south"], b["west"], b["north"]) / 1e6
    else:
        cell_km2 = 0.0
    area = {i: len(cs) * cell_km2 for i, cs in isl_cells.items()}
    rank = {i: r + 1 for r, (i, _) in enumerate(sorted(area.items(), key=lambda kv: -kv[1]))}
    gain = Counter()
    for j, isls in junction_isl.items():
        if len(isls) < 2:
            continue
        ps = sorted((isl_pop[i] for i in isls), reverse=True)
        g = sum(ps[1:])
        c = _cell(*junction_xy[j])
        if c and g > gain[c]:
            gain[c] = g
    rows = {}
    for c in set(low_km) | set(high_km):
        r = {"lowstress_km": round(low_km[c], 2), "highstress_km": round(high_km[c], 2), "_pop": pop.get(c, 0)}
        if cyc_km[c]:
            r["cycleway_km"] = round(cyc_km[c], 2)
        if c in main:
            i = main[c]
            r.update(island=rank[i], island_km2=round(area[i], 2), island_pop=round(isl_pop[i]))
        if gain[c]:
            r["crossing_gain"] = round(gain[c])
        rows[c] = r
    tot = sum(pop.values()) or 1
    small = sum(p for c, p in pop.items() if c in main and area[main[c]] < SMALL_ISLAND_KM2)
    summ = {"lowstress_km": round(sum(low_km.values())), "cycleway_km": round(sum(cyc_km.values()), 1),
            "highstress_km": round(sum(high_km.values())), "islands": len(area),
            "islands_over_5_km2": sum(1 for a in area.values() if a >= 5),
            "largest_island_km2": round(max(area.values(), default=0), 1),
            "pct_residents_small_island": round(100 * small / tot, 1),
            "pct_residents_no_lowstress_street": round(100 * sum(p for c, p in pop.items() if c not in main) / tot, 1),
            "source": f"Overture Maps transportation {OVERTURE_RELEASE}"}
    log(f"{region}: {len(segs)} segments, {len(blocked)} main-road junctions, {json.dumps(summ)}")
    return rows, summ


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    specs = [
        FieldSpec("lowstress_km", "Low-stress street length", agg="sum", unit="km", ramp="greens", higher_is="better"),
        FieldSpec("cycleway_km", "Mapped cycle track", agg="sum", unit="km", ramp="greens", higher_is="better"),
        FieldSpec("highstress_km", "Main-road length", agg="sum", unit="km", ramp="reds", higher_is="worse"),
        FieldSpec("island", "Low-stress island (1 = largest)", agg="mode", unit="id", ramp="viridis"),
        FieldSpec("island_km2", "Area you can cycle without crossing a main road", agg="mean", unit="km²",
                  domain=[0, 10], ramp="viridis", higher_is="better"),
        FieldSpec("island_pop", "Residents in the same low-stress island", agg="mean", unit="people",
                  ramp="viridis", higher_is="better"),
        FieldSpec("crossing_gain", "Residents joined by a safe crossing here", agg="max", unit="people",
                  ramp="heat", higher_is="better"),
    ]
    spec = DatasetSpec(
        id="cycling", title="Low-stress cycling network", level=LEVEL, fields=specs, group="Traffic & mobility",
        description="Overture Maps streets classed by Level of Traffic Stress from the road class (main roads "
                    "motorway–tertiary are high stress), joined into islands that never pass through a main-road "
                    "junction. Shows how far a cautious rider can go from each cell and which junction crossings "
                    "would join the most people to a bigger island. No lane, speed-limit or signal data.",
        source=f"pipeline/traffic/cycling.py over Overture Maps transportation {OVERTURE_RELEASE}",
        license="ODbL (Overture transportation, from OpenStreetMap)",
        default_field="island_km2", extrude=False)
    clean = ({"digipin": c, **{k: v for k, v in r.items() if not k.startswith("_")}} for c, r in rows.items())
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
    s["cycling"] = summ
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
