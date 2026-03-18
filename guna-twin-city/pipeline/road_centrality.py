"""
Road Network Centrality Analysis
=================================
Build a NetworkX graph from the OSM road GeoJSON and compute centrality
metrics per road segment:
  - Betweenness centrality (critical connector roads)
  - Closeness centrality (well-connected intersections)
  - Degree centrality (high-connectivity intersections)
  - Bridge edge detection (single-point-of-failure roads)

Outputs:
  1. Enriched GeoJSON with centrality properties
  2. Summary JSON with top critical segments and bridge count

Usage:
    python road_centrality.py
"""

import json
import logging
import math
import sys
from pathlib import Path

import networkx as nx

from config import BBOX_CITY, CITY_NAME, VECTOR_DIR

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
EARTH_RADIUS_M = 6_371_000


# ---------------------------------------------------------------------------
# Geometry helpers (stdlib only — no shapely/geopandas)
# ---------------------------------------------------------------------------

def haversine(lon1, lat1, lon2, lat2):
    """Return distance in metres between two WGS-84 points."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    )
    return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def linestring_length(coords):
    """Compute geodesic length of a LineString coordinate list in metres."""
    total = 0.0
    for i in range(len(coords) - 1):
        total += haversine(coords[i][0], coords[i][1],
                           coords[i + 1][0], coords[i + 1][1])
    return total


def extract_endpoints(geom):
    """Return (start_node, end_node) as rounded (lon, lat) tuples.

    For MultiLineString, uses the first point of the first segment
    and the last point of the last segment.
    """
    gtype = geom.get("type", "")
    coords = geom.get("coordinates", [])

    if gtype == "LineString" and len(coords) >= 2:
        start = coords[0][:2]
        end = coords[-1][:2]
    elif gtype == "MultiLineString" and coords:
        first_seg = coords[0]
        last_seg = coords[-1]
        if len(first_seg) >= 1 and len(last_seg) >= 1:
            start = first_seg[0][:2]
            end = last_seg[-1][:2]
        else:
            return None, None
    else:
        return None, None

    # Round to ~1m precision for node matching
    start_node = (round(start[0], 5), round(start[1], 5))
    end_node = (round(end[0], 5), round(end[1], 5))
    return start_node, end_node


def geometry_length(geom):
    """Return length in metres for LineString or MultiLineString."""
    gtype = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if gtype == "LineString":
        return linestring_length(coords)
    if gtype == "MultiLineString":
        return sum(linestring_length(c) for c in coords)
    return 0.0


def geometry_midpoint(geom):
    """Return approximate midpoint (lon, lat) of a line geometry."""
    gtype = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if gtype == "MultiLineString":
        coords = [pt for seg in coords for pt in seg]
    if not coords:
        return (0, 0)
    mid = coords[len(coords) // 2]
    return (mid[0], mid[1])


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_graph(features):
    """Build a NetworkX graph from road GeoJSON features.

    Nodes = intersection points (rounded lon/lat tuples).
    Edges = road segments with haversine distance as weight.

    Returns (graph, edge_to_features) where edge_to_features maps
    (start_node, end_node) -> list of feature indices sharing that edge.
    """
    G = nx.Graph()
    edge_to_features = {}

    skipped = 0
    for idx, feat in enumerate(features):
        geom = feat.get("geometry", {})
        props = feat.get("properties", {})

        start_node, end_node = extract_endpoints(geom)
        if start_node is None or end_node is None:
            skipped += 1
            continue

        # Skip self-loops (start == end)
        if start_node == end_node:
            skipped += 1
            continue

        length_m = geometry_length(geom)
        weight = max(length_m, 0.1)  # avoid zero-weight edges

        # Add nodes
        G.add_node(start_node)
        G.add_node(end_node)

        # Use the edge key (sorted tuple for undirected consistency)
        edge_key = (start_node, end_node)

        # If edge already exists, keep the shorter weight
        if G.has_edge(start_node, end_node):
            existing_weight = G[start_node][end_node].get("weight", float("inf"))
            if weight < existing_weight:
                G[start_node][end_node]["weight"] = weight
        else:
            G.add_edge(start_node, end_node, weight=weight)

        # Track which features map to this edge
        edge_to_features.setdefault(edge_key, []).append(idx)
        # Also store reverse key for lookup
        reverse_key = (end_node, start_node)
        edge_to_features.setdefault(reverse_key, []).append(idx)

    if skipped > 0:
        log.info("Skipped %d features (no valid endpoints or self-loops)", skipped)

    return G, edge_to_features


# ---------------------------------------------------------------------------
# Centrality computation
# ---------------------------------------------------------------------------

def compute_centrality(G):
    """Compute centrality metrics on the graph.

    Returns:
        edge_betweenness: dict of (u, v) -> betweenness score
        node_closeness: dict of node -> closeness score
        node_degree: dict of node -> degree centrality score
        bridges: set of (u, v) edge tuples that are bridges
    """
    log.info("Computing edge betweenness centrality (this may take a while)...")
    # Use k-sampling for large graphs to keep runtime reasonable
    n_nodes = G.number_of_nodes()
    if n_nodes > 2000:
        k = min(500, n_nodes)
        log.info("  Using k=%d sample nodes (graph has %d nodes)", k, n_nodes)
        edge_betweenness = nx.edge_betweenness_centrality(
            G, weight="weight", normalized=True, k=k
        )
    else:
        edge_betweenness = nx.edge_betweenness_centrality(
            G, weight="weight", normalized=True
        )
    log.info("  Edge betweenness: done (%d edges scored)", len(edge_betweenness))

    log.info("Computing node closeness centrality...")
    node_closeness = nx.closeness_centrality(G, distance="weight")
    log.info("  Closeness: done (%d nodes scored)", len(node_closeness))

    log.info("Computing node degree centrality...")
    node_degree = nx.degree_centrality(G)
    log.info("  Degree: done (%d nodes scored)", len(node_degree))

    log.info("Finding bridge edges...")
    bridges = set()
    for u, v in nx.bridges(G):
        bridges.add((u, v))
        bridges.add((v, u))
    log.info("  Found %d bridge edges", len(bridges) // 2)

    return edge_betweenness, node_closeness, node_degree, bridges


# ---------------------------------------------------------------------------
# Criticality scoring
# ---------------------------------------------------------------------------

def criticality_label(betweenness, is_bridge):
    """Assign a criticality label based on betweenness and bridge status."""
    if is_bridge and betweenness > 0.01:
        return "critical"
    if is_bridge:
        return "high"
    if betweenness > 0.01:
        return "high"
    if betweenness > 0.005:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# Enrichment
# ---------------------------------------------------------------------------

def enrich_and_write(features, geojson_data, G, edge_to_features,
                     edge_betweenness, node_closeness, node_degree,
                     bridges, output_geojson, output_summary):
    """Enrich each feature with centrality properties and write outputs."""

    # Build a lookup: feature_index -> (betweenness, closeness_avg, is_bridge)
    feature_metrics = {}

    for (u, v), betweenness in edge_betweenness.items():
        is_bridge = (u, v) in bridges
        closeness_avg = (node_closeness.get(u, 0) + node_closeness.get(v, 0)) / 2
        degree_avg = (node_degree.get(u, 0) + node_degree.get(v, 0)) / 2

        # Find features for this edge
        edge_key = (u, v)
        feat_indices = edge_to_features.get(edge_key, [])
        for idx in feat_indices:
            # Keep the highest betweenness if a feature maps to multiple edges
            existing = feature_metrics.get(idx)
            if existing is None or betweenness > existing["betweenness"]:
                feature_metrics[idx] = {
                    "betweenness": betweenness,
                    "closeness_avg": closeness_avg,
                    "degree_avg": degree_avg,
                    "is_bridge": is_bridge,
                }

    # Enrich features
    enriched_count = 0
    all_scored = []

    for idx, feat in enumerate(features):
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        metrics = feature_metrics.get(idx)

        if metrics is not None:
            betweenness = metrics["betweenness"]
            closeness_avg = metrics["closeness_avg"]
            degree_avg = metrics["degree_avg"]
            is_bridge = metrics["is_bridge"]
            enriched_count += 1
        else:
            betweenness = 0.0
            closeness_avg = 0.0
            degree_avg = 0.0
            is_bridge = False

        crit = criticality_label(betweenness, is_bridge)

        props["betweenness"] = round(betweenness, 6)
        props["closeness_avg"] = round(closeness_avg, 6)
        props["degree_avg"] = round(degree_avg, 6)
        props["is_bridge"] = is_bridge
        props["criticality"] = crit

        mid = geometry_midpoint(geom)
        all_scored.append({
            "feature_index": idx,
            "osm_id": props.get("osm_id", ""),
            "name": props.get("name", ""),
            "highway": props.get("highway", ""),
            "betweenness": round(betweenness, 6),
            "closeness_avg": round(closeness_avg, 6),
            "degree_avg": round(degree_avg, 6),
            "is_bridge": is_bridge,
            "criticality": crit,
            "lat": round(mid[1], 6),
            "lng": round(mid[0], 6),
        })

    log.info("Enriched %d / %d features with centrality metrics",
             enriched_count, len(features))

    # Write enriched GeoJSON
    output_geojson.parent.mkdir(parents=True, exist_ok=True)
    with open(output_geojson, "w", encoding="utf-8") as f:
        json.dump(geojson_data, f, ensure_ascii=False)
    log.info("Wrote enriched GeoJSON to %s", output_geojson)

    # Top 20 most critical segments (highest betweenness)
    top_critical = sorted(all_scored, key=lambda s: -s["betweenness"])[:20]

    # All bridge segments
    bridge_segments = [s for s in all_scored if s["is_bridge"]]
    bridge_count = len(bridge_segments)

    # Criticality distribution
    crit_dist = {}
    for s in all_scored:
        crit_dist[s["criticality"]] = crit_dist.get(s["criticality"], 0) + 1

    # Build summary
    summary = {
        "city": CITY_NAME,
        "total_segments": len(features),
        "graph_nodes": G.number_of_nodes(),
        "graph_edges": G.number_of_edges(),
        "bridge_count": bridge_count,
        "criticality_distribution": crit_dist,
        "top_20_critical_segments": top_critical,
        "bridge_segments": bridge_segments[:50],  # cap at 50 for readability
    }

    output_summary.parent.mkdir(parents=True, exist_ok=True)
    with open(output_summary, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    log.info("Wrote summary to %s", output_summary)

    # Print summary
    log.info("=== Centrality Summary ===")
    log.info("Graph: %d nodes, %d edges", G.number_of_nodes(), G.number_of_edges())
    log.info("Bridge edges: %d", bridge_count)
    log.info("Criticality distribution:")
    for label in ("critical", "high", "medium", "low"):
        count = crit_dist.get(label, 0)
        log.info("  %-10s %d", label, count)
    log.info("Top 5 critical segments:")
    for seg in top_critical[:5]:
        log.info("  osm_id=%-12s betweenness=%.6f bridge=%s  %s",
                 seg["osm_id"], seg["betweenness"], seg["is_bridge"],
                 seg["name"] or "(unnamed)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    input_roads = VECTOR_DIR / f"osm_roads_{CITY_NAME}.geojson"
    output_geojson = VECTOR_DIR / f"roads_centrality_{CITY_NAME}.geojson"
    output_summary = VECTOR_DIR / "centrality_summary.json"

    if not input_roads.exists():
        log.error("Input road file not found: %s", input_roads)
        sys.exit(1)

    # --- Step 1: Load road network ---
    log.info("Reading road GeoJSON from %s", input_roads)
    with open(input_roads, encoding="utf-8") as f:
        geojson_data = json.load(f)

    features = geojson_data.get("features", [])
    log.info("Loaded %d road features", len(features))

    # --- Step 2: Build graph ---
    log.info("Building NetworkX graph from road network...")
    G, edge_to_features = build_graph(features)
    log.info("Graph built: %d nodes, %d edges",
             G.number_of_nodes(), G.number_of_edges())

    # --- Step 3: Compute centrality metrics ---
    log.info("Computing centrality metrics...")
    edge_betweenness, node_closeness, node_degree, bridges = compute_centrality(G)

    # --- Step 4: Enrich and write outputs ---
    log.info("Enriching features and writing outputs...")
    enrich_and_write(
        features, geojson_data, G, edge_to_features,
        edge_betweenness, node_closeness, node_degree,
        bridges, output_geojson, output_summary,
    )

    log.info("Done.")


if __name__ == "__main__":
    main()
