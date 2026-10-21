"""Demand-driven traffic load: who drives where in the morning peak, and how
full each arterial road gets.

road_network.py grades roads by betweenness, which counts every pair of road
junctions as equally likely to exchange traffic. This module puts people
behind the flows instead, with a classic four-step model run entirely from
the open data already in the repo:

  1. Trip generation  residents per ~1 km zone (GHSL, cell store) make
                      ``TRIPS_PER_CAPITA`` motorised trips a day; zones attract
                      trips in proportion to jobs/activity floor space
                      (GHSL non-residential + a share of residential built
                      surface + mapped OSM amenities).
  2. Distribution     singly-constrained gravity model, exp(−β · minutes).
  3. Mode / PCU       one road-vehicle factor: PCU per motorised person trip
                      for an Indian mode mix (2W/car/auto/bus, IRC 106 PCUs).
  4. Assignment       morning peak hour (``PEAK_SHARE`` of the day) loaded
                      onto the arterial network in four increments
                      (40/30/20/10 %), re-timing links with the BPR curve
                      between increments, so congested roads shed traffic.

The network is the arterial OSM graph already baked for each city
(data/traffic/<region>/road_los.geojson, tertiary and up), split at every
shared vertex so crossings join up (the endpoint-only graph in
road_network.py leaves ~40 % of way ends dangling).

Outputs (both directions of a road are modelled; the busier one is reported):
    road_los.geojson   gains pcu_peak, vc_peak, los_peak, speed_peak, pcu_daily
    data/cells         dataset ``traffic_load`` (L7): peak flow, V/C, LOS,
                       speed, delay, daily vehicle-km per cell

Honest framing: a calibrated-by-assumption strategic model, not counts. It
shows where commuting demand meets thin capacity; it does not know signals,
lanes, one-way rules, parking or today's events. Constants are documented
below and in docs/TRAFFIC_MODEL.md.

    python -m pipeline.traffic.demand_model --region indore_pilot
    python -m pipeline.traffic.demand_model --region all
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
import time
from pathlib import Path

from pipeline._lib import digipin
from pipeline._lib.regions import CITY_PILOTS

REPO = Path(__file__).resolve().parents[2]
CELLS = REPO / "data" / "cells"

ZONE_LEVEL = 6               # ~975 m zones
CELL_LEVEL = 7               # ~244 m output cells
TRIPS_PER_CAPITA = 0.9       # motorised person trips/day (Indian CMPs: 0.8–1.2 excl. walk)
PCU_PER_TRIP = 0.37          # 2W 40% ·0.5/1.2, car 15% ·1/1.6, auto 15% ·1.2/2, bus 30% ·2.2/40 (IRC 106 PCUs)
PEAK_SHARE = 0.09            # peak hour share of daily traffic (IRC SP 41: 8–10%)
BETA_PER_MIN = 0.10          # gravity deterrence; mean trip ≈ 10–15 min (5–7 km)
INCREMENTS = (0.4, 0.3, 0.2, 0.1)
BPR_A, BPR_B = 0.15, 4
MAX_SLOWDOWN = 4.0           # reported speeds floor at a quarter of free flow (BPR explodes past V/C ≈ 2)
SNAP_M = 25.0                # join a dangling road end to a road vertex this close

# Free-flow speed (km/h) and capacity per direction (PCU/h) by OSM class.
# Capacities follow IRC 106-1990 urban roads with typical lane counts:
# 6-lane divided 2700/dir, 4-lane divided 1800/dir, 4-lane undivided 1500/dir,
# 2-lane two-way 750/dir.
ROAD = {
    "motorway": (70, 2700), "trunk": (55, 2700), "primary": (45, 1800),
    "secondary": (35, 1500), "tertiary": (30, 900),
    "motorway_link": (40, 1500), "trunk_link": (35, 1200), "primary_link": (30, 1200),
    "secondary_link": (30, 900), "tertiary_link": (25, 750),
}
DEFAULT_ROAD = (25, 750)
LOS_BANDS = ((0.35, "A"), (0.55, "B"), (0.75, "C"), (0.90, "D"), (1.00, "E"))


# ── pure helpers (unit-tested) ──────────────────────────────────────────────

def road_params(highway):
    """(free-flow km/h, capacity PCU/h per direction) for an OSM highway class."""
    return ROAD.get(highway or "", DEFAULT_ROAD)


def bpr_time(t0, flow, cap):
    """BPR link travel time for ``flow`` on capacity ``cap`` (same units as t0)."""
    return t0 * (1 + BPR_A * (flow / cap) ** BPR_B) if cap > 0 else t0


def los_grade(vc):
    """HCM-style Level of Service letter from a volume/capacity ratio."""
    for cut, g in LOS_BANDS:
        if vc <= cut:
            return g
    return "F"


def haversine_m(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 12_742_000 * math.asin(math.sqrt(a))


def gravity(productions, attractions, times, beta=BETA_PER_MIN):
    """Singly-constrained gravity: {dest: trips} for one origin.

    ``times`` maps reachable destination zone → minutes; every zone's share is
    A_j·exp(−β t_ij) over the sum, so the origin's trips are all distributed.
    """
    w = {j: attractions[j] * math.exp(-beta * t) for j, t in times.items() if attractions.get(j, 0) > 0}
    tot = sum(w.values())
    return {j: productions * v / tot for j, v in w.items()} if tot > 0 else {}


# ── network ─────────────────────────────────────────────────────────────────

class Network:
    """Directed arterial graph split at shared vertices.

    Nodes are road endpoints plus any vertex used by two or more ways; each
    undirected piece between nodes becomes two directed links. ``pieces``
    remembers which feature and vertex range a link came from.
    """

    def __init__(self, features):
        key = lambda p: (round(p[0], 6), round(p[1], 6))
        uses: dict = {}
        lines = []
        for fi, f in enumerate(features):
            g = f.get("geometry") or {}
            parts = [g["coordinates"]] if g.get("type") == "LineString" else \
                g.get("coordinates", []) if g.get("type") == "MultiLineString" else []
            for co in parts:
                if len(co) < 2:
                    continue
                lines.append((fi, co))
                for j, p in enumerate(co):
                    k = key(p)
                    uses[k] = uses.get(k, 0) + (2 if j in (0, len(co) - 1) else 1)
        # T-junction repair: a way that ends on another road without sharing
        # a vertex (simplified geometry) is snapped to that road's nearest
        # vertex within SNAP_M, which then becomes a junction.
        alias = {}
        cell = 0.0003
        grid: dict = {}
        for li, (fi, co) in enumerate(lines):
            for p in co:
                k = key(p)
                grid.setdefault((int(k[0] / cell), int(k[1] / cell)), []).append((k, li))
        for li, (fi, co) in enumerate(lines):
            for p in (co[0], co[-1]):
                k = key(p)
                if uses.get(k, 0) > 2:
                    continue
                gx, gy = int(k[0] / cell), int(k[1] / cell)
                best, bk = SNAP_M, None
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for q, lj in grid.get((gx + dx, gy + dy), ()):
                            if lj == li or q == k:
                                continue
                            d = haversine_m(k[0], k[1], q[0], q[1])
                            if d < best:
                                best, bk = d, q
                if bk is not None:
                    alias[k] = bk
                    uses[bk] = uses.get(bk, 0) + 2
        self.snapped = len(alias)
        self.node_id: dict = {}
        self.xy: list = []
        self.head, self.tail, self.length, self.t0, self.cap, self.feat = [], [], [], [], [], []
        self.mid: list = []          # link midpoint (lon, lat) per piece
        self.adj: list = []

        def nid(p):
            k = key(p)
            k = alias.get(k, k)
            i = self.node_id.get(k)
            if i is None:
                i = self.node_id[k] = len(self.xy)
                self.xy.append((p[0], p[1]))
                self.adj.append([])
            return i
        for fi, co in lines:
            hw = features[fi]["properties"].get("highway")
            v, c = road_params(hw)
            start, run = 0, 0.0
            for j in range(1, len(co)):
                run += haversine_m(co[j - 1][0], co[j - 1][1], co[j][0], co[j][1])
                if j == len(co) - 1 or uses.get(key(co[j]), 0) >= 2:
                    a, b = nid(co[start]), nid(co[j])
                    if a != b and run > 0:
                        m = co[(start + j) // 2]
                        for x, y in ((a, b), (b, a)):
                            self.adj[x].append(len(self.head))
                            self.tail.append(x)
                            self.head.append(y)
                            self.length.append(run)
                            self.t0.append(run / 1000 / v * 60)     # minutes
                            self.cap.append(c)
                            self.feat.append(fi)
                            self.mid.append((m[0], m[1]))
                    start, run = j, 0.0
        self.n = len(self.xy)
        self._largest_component()

    def _largest_component(self):
        seen = [-1] * self.n
        best, best_id = 0, -1
        for s in range(self.n):
            if seen[s] >= 0:
                continue
            stack, size = [s], 0
            seen[s] = s
            while stack:
                u = stack.pop()
                size += 1
                for e in self.adj[u]:
                    w = self.head[e]
                    if seen[w] < 0:
                        seen[w] = s
                        stack.append(w)
            if size > best:
                best, best_id = size, s
        self.main = [seen[i] == best_id for i in range(self.n)]

    def nearest_node(self, lon, lat):
        best, bi = float("inf"), -1
        kx = math.cos(math.radians(lat))
        for i, (x, y) in enumerate(self.xy):
            if not self.main[i]:
                continue
            d = ((x - lon) * kx) ** 2 + (y - lat) ** 2
            if d < best:
                best, bi = d, i
        return bi, math.sqrt(best) * 111_320

    def tree(self, src, times):
        """Dijkstra from ``src`` over link times: (dist, pred_link) lists."""
        INF = float("inf")
        dist = [INF] * self.n
        pred = [-1] * self.n
        dist[src] = 0.0
        pq = [(0.0, src)]
        adj, head = self.adj, self.head
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for e in adj[u]:
                v = head[e]
                nd = d + times[e]
                if nd < dist[v]:
                    dist[v] = nd
                    pred[v] = e
                    heapq.heappush(pq, (nd, v))
        return dist, pred


# ── zones from the cell store ───────────────────────────────────────────────

def _read(dataset, region):
    from pipeline.cells import store
    cat = json.loads((CELLS / "catalog.json").read_text())
    spec = next((d for d in cat["datasets"] if d["id"] == dataset), None)
    ent = spec and next((r for r in spec["regions"] if r["name"] == region), None)
    return store.read_region(CELLS, ent) if ent else None


def zones(region):
    """{L6 code: {"pop", "attr", "lon", "lat"}} from population, built-up and POIs."""
    pop, built, poi = _read("population", region), _read("built_up", region), _read("osm_amenities", region)
    if pop is None:
        raise RuntimeError(f"no population grid for {region}")
    z: dict = {}

    def zone(code):
        k = code[:ZONE_LEVEL]
        if k not in z:
            b = digipin.decode_partial(k)["bounds"]
            z[k] = {"pop": 0.0, "attr": 0.0, "lon": (b["west"] + b["east"]) / 2,
                    "lat": (b["south"] + b["north"]) / 2}
        return z[k]
    for code, p in zip(pop.codes, pop.columns["population"]):
        if p:
            zone(code)["pop"] += p
    if built is not None:
        from pipeline.cells import earthengine as gee
        for i, code in enumerate(built.codes):
            bp, nr = built.columns["built_pct"][i], built.columns["nonres_share_pct"][i]
            if not bp:
                continue
            m2 = bp / 100 * gee.cell_area_km2(code) * 1e6
            share = (nr or 0) / 100
            zone(code)["attr"] += m2 * share + 0.25 * m2 * (1 - share)
    if poi is not None:
        for code, n in zip(poi.codes, poi.columns["poi_total"]):
            if n:
                zone(code)["attr"] += 400.0 * n
    return z


# ── the model ───────────────────────────────────────────────────────────────

def run_model(net: Network, zs: dict, log=print):
    """Incremental peak-hour assignment. Returns per-link peak flow (PCU/h)."""
    conn = {}
    for k, z in zs.items():
        if z["pop"] <= 0 and z["attr"] <= 0:
            continue
        node, dm = net.nearest_node(z["lon"], z["lat"])
        if node >= 0 and dm <= 3000:
            conn[k] = node
    origins = [k for k in conn if zs[k]["pop"] >= 50]
    attr = {k: zs[k]["attr"] for k in conn}
    nlinks = len(net.head)
    flow = [0.0] * nlinks
    times = list(net.t0)
    import numpy as np
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    tail, head = np.array(net.tail), np.array(net.head)
    dest_nodes = np.array([conn[j] for j in conn])
    dest_keys = list(conn)
    dest_attr = np.array([attr[j] for j in dest_keys])
    for step, frac in enumerate(INCREMENTS):
        t = np.array(times)
        # Parallel links between one node pair: keep the quickest (csr would add them).
        best: dict = {}
        for e in range(nlinks):
            k = (net.tail[e], net.head[e])
            if k not in best or t[e] < t[best[k]]:
                best[k] = e
        keep = np.array(sorted(best.values()))
        g = csr_matrix((t[keep], (tail[keep], head[keep])), shape=(net.n, net.n))
        link_of = {(net.tail[e], net.head[e]): e for e in keep.tolist()}
        add = np.zeros(nlinks)
        for b0 in range(0, len(origins), 64):
            batch = origins[b0:b0 + 64]
            dist, pred = dijkstra(g, indices=[conn[o] for o in batch], return_predecessors=True)
            for r, o in enumerate(batch):
                d = dist[r]
                td = d[dest_nodes] + 2.0
                ok = np.isfinite(td) & (dest_nodes != conn[o]) & (dest_attr > 0)
                w = dest_attr * np.exp(-BETA_PER_MIN * np.where(ok, td, 0)) * ok
                tot = w.sum()
                if tot <= 0:
                    continue
                peak = zs[o]["pop"] * TRIPS_PER_CAPITA * PCU_PER_TRIP * PEAK_SHARE * frac
                demand = np.zeros(net.n)
                np.add.at(demand, dest_nodes, peak * w / tot)
                pr = pred[r]
                reach = np.nonzero(np.isfinite(d) & (pr >= 0))[0]
                dem = demand.tolist()
                prl = pr.tolist()
                for v in reach[np.argsort(-d[reach])].tolist():
                    x = dem[v]
                    if x == 0:
                        continue
                    u = prl[v]
                    add[link_of[(u, v)]] += x
                    dem[u] += x
        for e in range(nlinks):
            flow[e] += add[e]
            times[e] = bpr_time(net.t0[e], flow[e], net.cap[e])
        log(f"  increment {step + 1}/{len(INCREMENTS)}: {len(origins)} origins")
    return flow, times, len(origins), len(conn)


def summarise(net: Network, features, flow, times):
    """Per-feature and per-cell results from link flows."""
    per_feat: dict = {}
    cells: dict = {}
    for e in range(len(net.head)):
        fi, f, c = net.feat[e], flow[e], net.cap[e]
        vc = f / c
        t_rep = min(times[e], net.t0[e] * MAX_SLOWDOWN)
        sp = (net.length[e] / 1000) / (t_rep / 60) if t_rep > 0 else 0
        pf = per_feat.setdefault(fi, {"pcu": 0.0, "vc": 0.0, "speed": None, "wsum": 0.0, "len": 0.0})
        if f > pf["pcu"]:
            pf["pcu"] = f
        pf["vc"] = max(pf["vc"], vc)
        pf["wsum"] += sp * net.length[e]
        pf["len"] += net.length[e]
        lon, lat = net.mid[e]
        code = digipin.encode(lat, lon).replace("-", "")[:CELL_LEVEL]
        cc = cells.setdefault(code, {"pcu": 0.0, "vc": 0.0, "vkm": 0.0, "free": 0.0, "load": 0.0,
                                     "speed_w": 0.0, "len": 0.0})
        cc["pcu"] = max(cc["pcu"], f)
        cc["vc"] = max(cc["vc"], vc)
        cc["vkm"] += f / PEAK_SHARE * net.length[e] / 1000
        cc["free"] += f * net.t0[e]
        cc["load"] += f * t_rep
        cc["speed_w"] += sp * net.length[e]
        cc["len"] += net.length[e]
    for fi, pf in per_feat.items():
        p = features[fi]["properties"]
        p["pcu_peak"] = round(pf["pcu"])
        p["vc_peak"] = round(pf["vc"], 2)
        p["los_peak"] = los_grade(pf["vc"])
        p["speed_peak"] = round(pf["wsum"] / pf["len"], 1) if pf["len"] else None
        p["pcu_daily"] = round(pf["pcu"] / PEAK_SHARE, -1)
    rows = {}
    for code, cc in cells.items():
        rows[code] = {
            "peak_pcu": round(cc["pcu"]),
            "peak_vc": round(cc["vc"], 2),
            "peak_los": los_grade(cc["vc"]),
            "peak_speed_kmh": round(cc["speed_w"] / cc["len"], 1) if cc["len"] else None,
            "delay_pct": round(100 * (cc["load"] / cc["free"] - 1), 1) if cc["free"] > 0 else 0.0,
            "daily_vkm": round(cc["vkm"]),
        }
    return rows


def cell_dataset(region, rows):
    from pipeline.cells.schema import DatasetSpec, FieldSpec
    from pipeline.cells import store
    los_colors = {"A": "#31a354", "B": "#fdbb84", "C": "#fc8d59", "D": "#ef6548",
                  "E": "#d7301f", "F": "#7f0000"}
    specs = [
        FieldSpec("peak_vc", "Peak-hour volume / capacity (busiest road)", agg="max",
                  unit="ratio", domain=[0, 1.5], ramp="heat", higher_is="worse"),
        FieldSpec("peak_los", "Peak-hour Level of Service", type="category", agg="max",
                  colors=los_colors),
        FieldSpec("peak_pcu", "Peak-hour demand on the busiest road", agg="max", unit="PCU/h",
                  ramp="heat"),
        FieldSpec("peak_speed_kmh", "Peak-hour arterial speed", agg="mean", unit="km/h",
                  domain=[5, 50], ramp="heat", higher_is="better"),
        FieldSpec("delay_pct", "Peak-hour delay over free flow", agg="mean", unit="%",
                  domain=[0, 200], ramp="reds", higher_is="worse"),
        FieldSpec("daily_vkm", "Vehicle-km driven per day", agg="sum", unit="PCU-km/day",
                  ramp="heat"),
    ]
    spec = DatasetSpec(
        id="traffic_load", title="Traffic load (peak-hour model)", level=CELL_LEVEL,
        fields=specs, group="Traffic & mobility",
        description="Modelled morning peak hour on the arterial roads: residents (GHSL) make "
                    f"{TRIPS_PER_CAPITA} motorised trips a day toward jobs and activity floor "
                    "space (GHSL non-residential built-up, OSM amenities), distributed by a "
                    "gravity model and routed on the OSM arterial network with BPR congestion "
                    f"feedback; {PEAK_SHARE:.0%} of the day falls in the peak, "
                    f"{PCU_PER_TRIP} PCU per trip for an Indian mode mix, IRC 106 capacities. "
                    "A strategic model, not traffic counts: no signals, lane counts, one-way "
                    "rules or local streets.",
        source="pipeline/traffic/demand_model.py over OSM arterials (data/traffic) + GHSL + "
               "OSM amenities",
        license="ODbL (OpenStreetMap) + CC BY 4.0 (GHSL)",
        default_field="peak_vc", extrude=True, height_m=300)
    table = store.bin_records(({"digipin": c, **v} for c, v in rows.items()), CELL_LEVEL, specs)
    return store.write_dataset(CELLS, spec, region, table, parquet=False)


def run(region, log=print):
    t0 = time.time()
    path = REPO / "data" / "traffic" / region / "road_los.geojson"
    gj = json.loads(path.read_text())
    feats = gj["features"]
    net = Network(feats)
    zs = zones(region)
    log(f"{region}: {net.n} nodes, {len(net.head)} links, {len(zs)} zones")
    flow, times, n_orig, n_conn = run_model(net, zs, log)
    rows = summarise(net, feats, flow, times)
    path.write_text(json.dumps(gj, separators=(",", ":")))
    res = cell_dataset(region, rows)
    summ = REPO / "data" / "traffic" / region / "summary.json"
    s = json.loads(summ.read_text()) if summ.exists() else {}
    loaded = [f["properties"] for f in feats if f["properties"].get("los_peak")]
    km = lambda g: round(sum(1 for p in loaded if p["los_peak"] in g))
    s["demand_model"] = {
        "zones": n_conn, "origins": n_orig,
        "peak_pcu_total_trips": round(sum(z["pop"] for z in zs.values()) * TRIPS_PER_CAPITA
                                      * PCU_PER_TRIP * PEAK_SHARE),
        "roads_los_e_f": km("EF"), "roads_los_d": km("D"), "roads_total": len(loaded),
        "assumptions": {"trips_per_capita": TRIPS_PER_CAPITA, "pcu_per_trip": PCU_PER_TRIP,
                        "peak_share": PEAK_SHARE, "beta_per_min": BETA_PER_MIN},
    }
    summ.write_text(json.dumps(s, indent=2) + "\n")
    res["seconds"] = round(time.time() - t0, 1)
    log(json.dumps(res))
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--region", default="all")
    a = p.parse_args(argv)
    regions = list(CITY_PILOTS) if a.region == "all" else a.region.split(",")
    for r in regions:
        run(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
