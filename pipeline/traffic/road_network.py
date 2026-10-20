"""Structural road-traffic intelligence from the OSM road network.

DigiPin is a backend-less, keyless browser PWA, so *live* traffic feeds
(TomTom/HERE/Google/Mappls — all need API keys + a proxy + CORS) are out of
reach. Instead we compute a **structural** congestion signal that is well
grounded in the transport-geography literature and entirely free/offline:

  * **Betweenness centrality** of the road graph — the share of shortest paths
    that run through each segment. Network betweenness is a long-established
    proxy for through-traffic *volume* (segments many trips must traverse carry
    more load), so high-betweenness roads are the structural bottlenecks.
  * **Level of Service (LOS A-F)** from a volume-to-capacity ratio — the
    standard Highway-Capacity-Manual definition (and the LOS concept TraffiQ
    uses), here with volume = normalised betweenness and capacity inferred from
    the OSM `highway` class. Higher V/C ⇒ worse LOS ⇒ higher congestion risk.
  * **Bridge edges** — single-points-of-failure whose removal disconnects part
    of the network (critical links for resilience planning).

The graph build + betweenness reuse the approach in
`guna-twin-city/pipeline/road_centrality.py`. The pure scoring helpers
(`capacity_for_class`, `los_from_vc`, `congestion_risk`) are numpy/stdlib and
unit-tested; NetworkX + raster/vector IO are imported lazily so tests skip
cleanly when the heavy deps (or the multi-GB OSM extract) aren't present.

Output (small, browser-fetchable):
    data/traffic/<region>/road_los.geojson   roads + betweenness/los/criticality
    data/traffic/<region>/summary.json       top bottlenecks + critical links

Honest framing: this is *structural* congestion (where load concentrates by
network design), not real-time delays.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
from pathlib import Path

from pipeline._lib.regions import get_default_bbox, get_default_region_name

log = logging.getLogger("pipeline.traffic.road_network")

EARTH_RADIUS_M = 6_371_000

# Relative road capacity by OSM highway class (vehicles/hr order-of-magnitude,
# normalised to 0..1). Trunk/primary carry the most; service/residential least.
# Used as the denominator of the V/C ratio. Unknown/None → a low-mid default.
CLASS_CAPACITY = {
    "motorway": 1.00, "motorway_link": 0.80,
    "trunk": 0.90, "trunk_link": 0.70,
    "primary": 0.75, "primary_link": 0.55,
    "secondary": 0.55, "secondary_link": 0.45,
    "tertiary": 0.40, "tertiary_link": 0.35,
    "unclassified": 0.30,
    "residential": 0.25, "living_street": 0.15,
    "service": 0.15, "track": 0.10,
}
DEFAULT_CAPACITY = 0.30
LOS_GRADES = ["A", "B", "C", "D", "E", "F"]


# ───────────────────────── pure scoring helpers ─────────────────────────
def capacity_for_class(highway):
    """Relative capacity (0..1) for an OSM highway class. Pure."""
    if isinstance(highway, (list, tuple)):
        highway = highway[0] if highway else None
    return CLASS_CAPACITY.get(highway, DEFAULT_CAPACITY)


def los_from_vc(vc_ratio):
    """Level-of-Service grade A..F from a volume/capacity ratio. Pure.

    HCM-style breakpoints: ≤0.6 free-flow (A/B), ~0.8 stable (C), ~0.9 nearing
    capacity (D), ~1.0 at capacity (E), >1.0 over capacity / breakdown (F)."""
    if vc_ratio is None or not math.isfinite(vc_ratio):
        return None
    cuts = [0.35, 0.55, 0.75, 0.90, 1.00]   # upper edge of A,B,C,D,E
    for i, c in enumerate(cuts):
        if vc_ratio <= c:
            return LOS_GRADES[i]
    return "F"


def congestion_risk(vc_ratio):
    """0..100 congestion-risk score from a V/C ratio (clamped). Pure."""
    if vc_ratio is None or not math.isfinite(vc_ratio):
        return None
    return int(round(max(0.0, min(1.0, vc_ratio)) * 100))


def vc_ratio(betweenness, capacity):
    """Volume/capacity proxy: normalised betweenness ÷ class capacity. Pure.

    betweenness is already 0..1 (nx normalized=True); dividing by capacity (0..1)
    yields a ratio that can exceed 1 on low-capacity high-load segments."""
    cap = capacity if (capacity and capacity > 0) else DEFAULT_CAPACITY
    if betweenness is None or not math.isfinite(betweenness):
        return None
    return betweenness / cap


def criticality_label(betweenness, is_bridge):
    """Criticality from betweenness + bridge status (cf. road_centrality.py). Pure."""
    if is_bridge and betweenness > 0.01:
        return "critical"
    if is_bridge or betweenness > 0.01:
        return "high"
    if betweenness > 0.005:
        return "medium"
    return "low"


# ───────────────────────── geometry (stdlib only) ─────────────────────────
def _haversine(lon1, lat1, lon2, lat2):
    """Great-circle distance in metres between two lon/lat points."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _endpoints(geom):
    """Return rounded (start, end) coordinate tuples of a (Multi)LineString, or (None, None)."""
    gtype, coords = geom.get("type", ""), geom.get("coordinates", [])
    if gtype == "LineString" and len(coords) >= 2:
        start, end = coords[0][:2], coords[-1][:2]
    elif gtype == "MultiLineString" and coords and coords[0] and coords[-1]:
        start, end = coords[0][0][:2], coords[-1][-1][:2]
    else:
        return None, None
    return (round(start[0], 5), round(start[1], 5)), (round(end[0], 5), round(end[1], 5))


def _length_m(geom):
    """Total length in metres of a (Multi)LineString geometry."""
    gtype, coords = geom.get("type", ""), geom.get("coordinates", [])
    segs = [coords] if gtype == "LineString" else coords if gtype == "MultiLineString" else []
    total = 0.0
    for seg in segs:
        for i in range(len(seg) - 1):
            total += _haversine(seg[i][0], seg[i][1], seg[i + 1][0], seg[i + 1][1])
    return total


def _midpoint(geom):
    """Approximate midpoint coordinate of a (Multi)LineString geometry."""
    gtype, coords = geom.get("type", ""), geom.get("coordinates", [])
    if gtype == "MultiLineString":
        coords = [pt for seg in coords for pt in seg]
    if not coords:
        return (0.0, 0.0)
    mid = coords[len(coords) // 2]
    return (mid[0], mid[1])


# ───────────────────────── graph + centrality (lazy networkx) ─────────────
def build_graph(features):
    """NetworkX graph from road features; returns (G, edge_to_features)."""
    import networkx as nx
    G = nx.Graph()
    edge_to_features = {}
    for idx, feat in enumerate(features):
        a, b = _endpoints(feat.get("geometry", {}))
        if a is None or b is None or a == b:
            continue
        w = max(_length_m(feat["geometry"]), 0.1)
        if G.has_edge(a, b):
            if w < G[a][b].get("weight", float("inf")):
                G[a][b]["weight"] = w
        else:
            G.add_edge(a, b, weight=w)
        edge_to_features.setdefault((a, b), []).append(idx)
        edge_to_features.setdefault((b, a), []).append(idx)
    return G, edge_to_features


def compute_centrality(G):
    """Edge betweenness (k-sampled for big graphs) + bridge set. Lazy networkx."""
    import networkx as nx
    n = G.number_of_nodes()
    kw = {"weight": "weight", "normalized": True}
    if n > 2000:
        kw["k"] = min(500, n)
        kw["seed"] = 42          # reproducible sampled betweenness
    betw = nx.edge_betweenness_centrality(G, **kw)
    bridges = set()
    for u, v in nx.bridges(G):
        bridges.add((u, v))
        bridges.add((v, u))
    return betw, bridges


# ───────────────────────── orchestration ─────────────────────────
def _percentile(values, q):
    """q-th percentile (0..1) of a list via nearest-rank. Pure stdlib."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return 0.0
    k = min(len(vals) - 1, max(0, int(round(q * (len(vals) - 1)))))
    return vals[k]


def enrich(features, betw, bridges, edge_to_features):
    """Attach betweenness/capacity/los/criticality to each feature in place.
    Returns the scored-segment list (one dict per feature).

    Raw normalized betweenness from a city graph is tiny (~1e-2), so we rescale
    it to a **relative load** (segment betweenness ÷ the network's 95th-percentile
    betweenness) before the V/C ratio — that's what spreads LOS across A–F instead
    of collapsing every road to free-flow."""
    per_feature = {}
    for (u, v), b in betw.items():
        is_bridge = (u, v) in bridges
        for idx in edge_to_features.get((u, v), []):
            cur = per_feature.get(idx)
            if cur is None or b > cur["betweenness"]:
                per_feature[idx] = {"betweenness": b, "is_bridge": is_bridge}

    # Robust scale: 95th-percentile betweenness (so a cluster of top arterials
    # reaches capacity, not just a single outlier). Fallback to max.
    bvals = [m["betweenness"] for m in per_feature.values() if m["betweenness"] > 0]
    scale = _percentile(bvals, 0.95) or (max(bvals) if bvals else 0.0)

    scored = []
    for idx, feat in enumerate(features):
        props = feat.setdefault("properties", {})
        m = per_feature.get(idx, {"betweenness": 0.0, "is_bridge": False})
        b, is_bridge = m["betweenness"], m["is_bridge"]
        cap = capacity_for_class(props.get("highway"))
        rel_load = (b / scale) if scale > 0 else 0.0   # 0..~1 (top arterials ≈ 1)
        ratio = vc_ratio(rel_load, cap)
        grade = los_from_vc(ratio)
        risk = congestion_risk(ratio)
        crit = criticality_label(b, is_bridge)
        props.update({
            "betweenness": round(b, 6), "capacity": round(cap, 3),
            "vc_ratio": round(ratio, 4) if ratio is not None else None,
            "los_grade": grade, "congestion_risk": risk,
            "is_bridge": is_bridge, "criticality": crit,
        })
        mid = _midpoint(feat.get("geometry", {}))
        scored.append({
            "osm_id": props.get("osm_id", props.get("id", "")),
            "name": props.get("name", ""), "highway": props.get("highway", ""),
            "betweenness": round(b, 6), "los_grade": grade,
            "congestion_risk": risk, "is_bridge": is_bridge, "criticality": crit,
            "lat": round(mid[1], 6), "lng": round(mid[0], 6),
        })
    return scored


def run(region=None, roads_path=None, out_dir=None):
    """Full pipeline: read roads geojson, score, write road_los.geojson + summary."""
    region = region or get_default_region_name()
    roads = Path(roads_path) if roads_path else Path(f"data/vectors/osm_roads_{region}.geojson")
    if not roads.exists():
        raise SystemExit(f"missing {roads} — extract OSM roads for the region first")

    gj = json.loads(roads.read_text())
    features = gj.get("features", [])
    log.info("loaded %d road features", len(features))

    G, e2f = build_graph(features)
    log.info("graph: %d nodes, %d edges", G.number_of_nodes(), G.number_of_edges())
    betw, bridges = compute_centrality(G)
    scored = enrich(features, betw, bridges, e2f)

    out_dir = Path(out_dir) if out_dir else Path(f"data/traffic/{region}")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "road_los.geojson").write_text(json.dumps(gj, separators=(",", ":")))

    dist = {}
    for s in scored:
        dist[s["los_grade"]] = dist.get(s["los_grade"], 0) + 1
    summary = {
        "region": region,
        "total_segments": len(features),
        "graph_nodes": G.number_of_nodes(),
        "graph_edges": G.number_of_edges(),
        "bridge_count": sum(1 for s in scored if s["is_bridge"]),
        "los_distribution": dist,
        "top_bottlenecks": sorted(scored, key=lambda s: -s["betweenness"])[:20],
        "critical_links": [s for s in scored if s["criticality"] == "critical"][:50],
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    log.info("wrote %s (%d segments, %d bridges)",
             out_dir / "road_los.geojson", len(features), summary["bridge_count"])
    return summary


def main():
    """CLI: build the structural road-network level-of-service layer from OSM roads."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--roads", default=None, help="OSM roads geojson (default data/vectors/osm_roads_<region>.geojson)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    run(roads_path=args.roads, out_dir=args.out)


if __name__ == "__main__":
    main()
