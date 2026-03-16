#!/usr/bin/env python3
"""
Guna Urban Morphology Analysis — City2Graph
=============================================
Uses city2graph to build morphological, proximity, and street network graphs
from Guna's building footprints, road network, and POI data.

Analyses:
1. Morphological graph: building tessellation + street connectivity
2. Street network dual graph: intersection-to-intersection topology
3. Building proximity graph: KNN spatial neighbors
4. POI proximity graph: amenity access zones
5. Admin boundary contiguity: ward adjacency

Outputs:
- GeoJSON files for map visualization
- NetworkX graph statistics
- HTML morphology map
"""

import json
import sys
import warnings
from pathlib import Path

import geopandas as gpd
import numpy as np
from shapely.geometry import box

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

# Paths
DATA_DIR = Path(__file__).parent.parent / "data"
VECTOR_DIR = DATA_DIR / "vectors"
OUT_DIR = Path(__file__).parent / "output"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Guna old city core bbox (where traffic analysis + one-way proposals focus)
OLD_CITY = box(77.295, 24.630, 77.325, 24.655)
# Wider city core
CITY_CORE = box(77.25, 24.58, 77.38, 24.70)


def load_buildings(bbox=None):
    """Load Google Open Buildings, optionally clipped to bbox."""
    print("  Loading buildings...")
    gdf = gpd.read_file(VECTOR_DIR / "google_open_buildings_guna.geojson")
    if bbox is not None:
        gdf = gdf[gdf.intersects(bbox)].copy()
    # Ensure valid geometries
    gdf = gdf[gdf.geometry.is_valid & ~gdf.geometry.is_empty].copy()
    gdf = gdf.reset_index(drop=True)
    print(f"    {len(gdf)} buildings loaded")
    return gdf


def load_roads(bbox=None):
    """Load OSM roads, optionally clipped to bbox."""
    print("  Loading roads...")
    gdf = gpd.read_file(VECTOR_DIR / "osm_roads_guna.geojson")
    if bbox is not None:
        gdf = gdf[gdf.intersects(bbox)].copy()
    gdf = gdf[gdf.geometry.is_valid & ~gdf.geometry.is_empty].copy()
    gdf = gdf.reset_index(drop=True)
    print(f"    {len(gdf)} road segments loaded")
    return gdf


def load_pois(bbox=None):
    """Load OSM POIs."""
    print("  Loading POIs...")
    gdf = gpd.read_file(VECTOR_DIR / "osm_pois_guna.geojson")
    if bbox is not None:
        gdf = gdf[gdf.intersects(bbox)].copy()
    gdf = gdf[gdf.geometry.is_valid & ~gdf.geometry.is_empty].copy()
    gdf = gdf.reset_index(drop=True)
    print(f"    {len(gdf)} POIs loaded")
    return gdf


def load_green_spaces(bbox=None):
    """Load OSM green spaces."""
    print("  Loading green spaces...")
    gdf = gpd.read_file(VECTOR_DIR / "osm_green_spaces_guna.geojson")
    if bbox is not None:
        gdf = gdf[gdf.intersects(bbox)].copy()
    gdf = gdf[gdf.geometry.is_valid & ~gdf.geometry.is_empty].copy()
    gdf = gdf.reset_index(drop=True)
    print(f"    {len(gdf)} green spaces loaded")
    return gdf


# ═══════════════════════════════════════
# ANALYSIS 1: Morphological Tessellation
# ═══════════════════════════════════════

def analysis_tessellation(buildings, limit=None):
    """Create Voronoi tessellation around buildings — urban 'territory' per building."""
    import city2graph

    print("\n[1] MORPHOLOGICAL TESSELLATION")

    if limit and len(buildings) > limit:
        print(f"  Sampling {limit} buildings from {len(buildings)} (memory constraint)...")
        buildings = buildings.sample(n=limit, random_state=42).reset_index(drop=True)

    # Project to meters for accurate tessellation
    buildings_proj = buildings.to_crs(epsg=32643)  # UTM 43N (covers Guna)

    print("  Creating tessellation...")
    tess = city2graph.create_tessellation(
        buildings_proj,
        shrink=0.4,  # Shrink factor to avoid overlapping tessellation cells
    )

    print(f"    Tessellation cells: {len(tess)}")

    # Compute area stats
    tess["tess_area_m2"] = tess.geometry.area
    print(f"    Mean cell area: {tess['tess_area_m2'].mean():.0f} m2")
    print(f"    Median cell area: {tess['tess_area_m2'].median():.0f} m2")

    # Save as GeoJSON (back to WGS84)
    tess_wgs = tess.to_crs(epsg=4326)
    out_path = OUT_DIR / "tessellation_guna.geojson"
    tess_wgs.to_file(out_path, driver="GeoJSON")
    print(f"    Saved: {out_path.name}")

    return tess


# ═══════════════════════════════════════
# ANALYSIS 2: Street Network Dual Graph
# ═══════════════════════════════════════

def analysis_street_graph(roads):
    """Build dual graph of street network — streets as nodes, intersections as edges."""
    import city2graph
    import networkx as nx

    print("\n[2] STREET NETWORK DUAL GRAPH")

    # Filter to drivable roads
    drivable = roads[roads["highway"].isin([
        "trunk", "primary", "secondary", "tertiary",
        "residential", "unclassified", "living_street",
    ])].copy()
    print(f"  Drivable segments: {len(drivable)}")

    # Project to meters
    drivable_proj = drivable.to_crs(epsg=32643)

    # Build dual graph: each street segment becomes a node,
    # edges connect segments that share an intersection
    print("  Building dual graph...")
    G = city2graph.dual_graph(drivable_proj, id_column="osm_id")

    print(f"    Nodes (street segments): {G.number_of_nodes()}")
    print(f"    Edges (intersections): {G.number_of_edges()}")

    # Graph metrics
    if G.number_of_nodes() > 0:
        degrees = [d for _, d in G.degree()]
        print(f"    Avg connectivity: {np.mean(degrees):.1f}")
        print(f"    Max connectivity: {max(degrees)}")

        # Connected components
        if not nx.is_directed(G):
            components = list(nx.connected_components(G))
        else:
            components = list(nx.weakly_connected_components(G))
        print(f"    Connected components: {len(components)}")
        print(f"    Largest component: {max(len(c) for c in components)} nodes")

    return G


# ═══════════════════════════════════════
# ANALYSIS 3: Building KNN Proximity
# ═══════════════════════════════════════

def analysis_building_proximity(buildings, k=6, limit=None):
    """Build K-nearest-neighbor graph of buildings — spatial clustering."""
    import city2graph

    print("\n[3] BUILDING KNN PROXIMITY GRAPH")

    if limit and len(buildings) > limit:
        print(f"  Sampling {limit} buildings...")
        buildings = buildings.sample(n=limit, random_state=42).reset_index(drop=True)

    buildings_proj = buildings.to_crs(epsg=32643)

    print(f"  Building KNN graph (k={k})...")
    G = city2graph.knn_graph(buildings_proj, k=k)

    print(f"    Nodes: {G.number_of_nodes()}")
    print(f"    Edges: {G.number_of_edges()}")

    # Analyze edge distances
    distances = []
    for u, v, data in G.edges(data=True):
        if "weight" in data:
            distances.append(data["weight"])

    if distances:
        print(f"    Avg neighbor distance: {np.mean(distances):.1f}m")
        print(f"    Max neighbor distance: {np.max(distances):.1f}m")
        print(f"    Median neighbor distance: {np.median(distances):.1f}m")

    return G


# ═══════════════════════════════════════
# ANALYSIS 4: Fixed Radius Building Graph
# ═══════════════════════════════════════

def analysis_fixed_radius(buildings, radius=100, limit=None):
    """Build fixed-radius proximity graph — all buildings within radius are connected."""
    import city2graph

    print(f"\n[4] FIXED RADIUS GRAPH (r={radius}m)")

    if limit and len(buildings) > limit:
        print(f"  Sampling {limit} buildings...")
        buildings = buildings.sample(n=limit, random_state=42).reset_index(drop=True)

    buildings_proj = buildings.to_crs(epsg=32643)

    print(f"  Building fixed-radius graph...")
    G = city2graph.fixed_radius_graph(buildings_proj, radius=radius)

    print(f"    Nodes: {G.number_of_nodes()}")
    print(f"    Edges: {G.number_of_edges()}")

    degrees = [d for _, d in G.degree()]
    if degrees:
        print(f"    Avg degree: {np.mean(degrees):.1f}")
        print(f"    Max degree: {max(degrees)} (densest cluster)")
        # High-degree nodes = dense building clusters
        dense_count = sum(1 for d in degrees if d > np.mean(degrees) + 2 * np.std(degrees))
        print(f"    Dense clusters (>2σ): {dense_count} buildings")

    return G


# ═══════════════════════════════════════
# ANALYSIS 5: Contiguity Graph (Admin)
# ═══════════════════════════════════════

def analysis_contiguity(green_spaces):
    """Build contiguity graph from green spaces — which parks/forests are adjacent."""
    import city2graph

    print("\n[5] GREEN SPACE CONTIGUITY GRAPH")

    if len(green_spaces) < 3:
        print("  Not enough green spaces for contiguity analysis")
        return None

    green_proj = green_spaces.to_crs(epsg=32643)

    # Buffer slightly to catch near-adjacent spaces
    print("  Building contiguity graph (Queen adjacency with 50m buffer)...")
    G = city2graph.contiguity_graph(green_proj, contiguity="queen")

    print(f"    Nodes (green spaces): {G.number_of_nodes()}")
    print(f"    Edges (adjacencies): {G.number_of_edges()}")

    if G.number_of_edges() > 0:
        import networkx as nx
        components = list(nx.connected_components(G))
        print(f"    Green corridors (connected components): {len(components)}")
        print(f"    Largest corridor: {max(len(c) for c in components)} spaces")

    return G


# ═══════════════════════════════════════
# ANALYSIS 6: Morphological Graph
# ═══════════════════════════════════════

def analysis_morphological(buildings, roads, limit=None):
    """Build full morphological graph: buildings + streets + their interfaces."""
    import city2graph

    print("\n[6] FULL MORPHOLOGICAL GRAPH")

    if limit and len(buildings) > limit:
        print(f"  Sampling {limit} buildings...")
        buildings = buildings.sample(n=limit, random_state=42).reset_index(drop=True)

    buildings_proj = buildings.to_crs(epsg=32643)

    drivable = roads[roads["highway"].isin([
        "trunk", "primary", "secondary", "tertiary",
        "residential", "unclassified",
    ])].copy()
    roads_proj = drivable.to_crs(epsg=32643)

    print(f"  Buildings: {len(buildings_proj)}, Roads: {len(roads_proj)}")
    print("  Building morphological graph (tessellation + dual + interfaces)...")

    G = city2graph.morphological_graph(
        buildings_proj,
        roads_proj,
        shrink=0.4,
    )

    # Analyze heterogeneous graph
    node_types = {}
    for n, data in G.nodes(data=True):
        ntype = data.get("node_type", "unknown")
        node_types[ntype] = node_types.get(ntype, 0) + 1

    edge_types = {}
    for u, v, data in G.edges(data=True):
        etype = data.get("edge_type", "unknown")
        edge_types[etype] = edge_types.get(etype, 0) + 1

    print(f"    Total nodes: {G.number_of_nodes()}")
    for ntype, count in sorted(node_types.items()):
        print(f"      {ntype}: {count}")
    print(f"    Total edges: {G.number_of_edges()}")
    for etype, count in sorted(edge_types.items()):
        print(f"      {etype}: {count}")

    return G


# ═══════════════════════════════════════
# VISUALIZATION
# ═══════════════════════════════════════

def generate_morphology_map(tess_gdf, buildings, roads):
    """Generate interactive HTML map showing tessellation + buildings + roads."""
    print("\n[MAP] Generating morphology visualization...")

    tess_wgs = tess_gdf.to_crs(epsg=4326) if tess_gdf.crs.to_epsg() != 4326 else tess_gdf

    # Sample tessellation cells for JSON (limit size)
    tess_sample = tess_wgs.head(2000)
    tess_features = json.loads(tess_sample.to_json())

    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Guna Urban Morphology — City2Graph Analysis</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: 'Segoe UI', sans-serif; background: #0a0a1a; color: #e0e0e0; }
#map { position: absolute; top: 0; left: 0; right: 380px; bottom: 0; }
#panel { position: absolute; top: 0; right: 0; width: 380px; bottom: 0;
         background: #0d1b2a; overflow-y: auto; padding: 20px;
         border-left: 2px solid #1b2838; }
h1 { font-size: 18px; color: #00e5ff; margin-bottom: 4px; }
h2 { font-size: 14px; color: #7c4dff; margin: 16px 0 8px; border-bottom: 1px solid #1b2838; padding-bottom: 4px; }
.sub { font-size: 12px; color: #666; margin-bottom: 16px; }
.stat { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
.stat-label { color: #aaa; }
.stat-val { color: #00e5ff; font-weight: 600; }
.legend { margin-top: 8px; }
.leg { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px; }
.leg-box { width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; }
.note { font-size: 11px; color: #666; margin-top: 12px; line-height: 1.6; }
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
    <h1>Guna Urban Morphology</h1>
    <div class="sub">City2Graph tessellation + street network analysis</div>

    <h2>Tessellation Stats</h2>
    <div class="stat"><span class="stat-label">Cells generated</span><span class="stat-val" id="s-cells">—</span></div>
    <div class="stat"><span class="stat-label">Mean area</span><span class="stat-val" id="s-mean">—</span></div>
    <div class="stat"><span class="stat-label">Median area</span><span class="stat-val" id="s-median">—</span></div>
    <div class="stat"><span class="stat-label">Buildings analyzed</span><span class="stat-val" id="s-bldg">—</span></div>

    <h2>Legend</h2>
    <div class="legend">
        <div class="leg"><div class="leg-box" style="background:rgba(0,229,255,0.3);border:1px solid #00e5ff"></div> Tessellation cell (Voronoi)</div>
        <div class="leg"><div class="leg-box" style="background:rgba(255,152,0,0.6)"></div> Building footprint</div>
        <div class="leg"><div class="leg-box" style="background:#7c4dff;width:24px;height:3px;border-radius:2px"></div> Road network</div>
    </div>

    <h2>What is Tessellation?</h2>
    <div class="note">
        Morphological tessellation divides space into Voronoi cells around each building.
        Each cell represents the "territory" controlled by that building — the area closer
        to it than to any other building. Cell size reveals urban density: small cells = dense
        urban fabric, large cells = sparse suburban/rural areas.
        <br><br>
        <strong>Powered by:</strong> city2graph + momepy
    </div>

    <h2>Click a Cell</h2>
    <div id="cell-info" class="note">Click any tessellation cell to see its properties.</div>
</div>

<script>
var map = L.map('map').setView([24.642, 77.310], 15);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png', {
    attribution: '&copy; CARTO &copy; OSM', maxZoom: 19
}).addTo(map);

var tessLayer = L.layerGroup().addTo(map);
var bldgLayer = L.layerGroup();
var roadLayer = L.layerGroup().addTo(map);

// Tessellation cells
var tessData = TESS_DATA_PLACEHOLDER;
var cellCount = 0;
var areas = [];

function areaColor(area) {
    if (area < 200) return '#ff1744';     // Very dense
    if (area < 500) return '#ff9100';     // Dense
    if (area < 1000) return '#ffd600';    // Medium
    if (area < 3000) return '#00e676';    // Suburban
    return '#448aff';                      // Rural/sparse
}

L.geoJSON(tessData, {
    style: function(feature) {
        var area = feature.properties.tess_area_m2 || 0;
        return {
            fillColor: areaColor(area),
            fillOpacity: 0.35,
            color: 'rgba(0,229,255,0.4)',
            weight: 1
        };
    },
    onEachFeature: function(feature, layer) {
        cellCount++;
        var area = feature.properties.tess_area_m2 || 0;
        areas.push(area);
        layer.on('click', function() {
            var info = document.getElementById('cell-info');
            info.textContent = 'Area: ' + Math.round(area) + ' m2 | ' +
                'Confidence: ' + (feature.properties.confidence || '?') + ' | ' +
                'Building area: ' + Math.round(feature.properties.area_in_meters || 0) + ' m2';
        });
    }
}).addTo(tessLayer);

// Stats
document.getElementById('s-cells').textContent = cellCount;
if (areas.length > 0) {
    areas.sort(function(a,b){return a-b;});
    var mean = areas.reduce(function(a,b){return a+b;},0) / areas.length;
    document.getElementById('s-mean').textContent = Math.round(mean) + ' m2';
    document.getElementById('s-median').textContent = Math.round(areas[Math.floor(areas.length/2)]) + ' m2';
}

L.control.layers(null, {
    'Tessellation': tessLayer,
    'Roads': roadLayer
}).addTo(map);
</script>
</body>
</html>"""

    html = html.replace('TESS_DATA_PLACEHOLDER', json.dumps(tess_features))

    out_path = OUT_DIR / "morphology_map.html"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"    Saved: {out_path.name}")


# ═══════════════════════════════════════
# MAIN
# ═══════════════════════════════════════

def main():
    print("=" * 60)
    print("GUNA URBAN MORPHOLOGY — City2Graph Analysis")
    print("=" * 60)

    # Load data (old city core for manageable size)
    buildings = load_buildings(bbox=OLD_CITY)
    roads = load_roads(bbox=OLD_CITY)
    pois = load_pois(bbox=OLD_CITY)
    green = load_green_spaces(bbox=OLD_CITY)

    results = {}

    # 1. Tessellation (limit to 3000 for memory)
    try:
        tess = analysis_tessellation(buildings, limit=3000)
        results["tessellation"] = {"cells": len(tess), "mean_area_m2": round(tess["tess_area_m2"].mean(), 1)}
        generate_morphology_map(tess, buildings, roads)
    except Exception as e:
        print(f"  ERROR in tessellation: {e}")
        tess = None

    # 2. Street dual graph
    try:
        street_G = analysis_street_graph(roads)
        results["street_graph"] = {"nodes": street_G.number_of_nodes(), "edges": street_G.number_of_edges()}
    except Exception as e:
        print(f"  ERROR in street graph: {e}")

    # 3. Building KNN proximity
    try:
        knn_G = analysis_building_proximity(buildings, k=6, limit=3000)
        results["knn_graph"] = {"nodes": knn_G.number_of_nodes(), "edges": knn_G.number_of_edges()}
    except Exception as e:
        print(f"  ERROR in KNN graph: {e}")

    # 4. Fixed radius graph
    try:
        fr_G = analysis_fixed_radius(buildings, radius=50, limit=3000)
        results["fixed_radius_graph"] = {"nodes": fr_G.number_of_nodes(), "edges": fr_G.number_of_edges()}
    except Exception as e:
        print(f"  ERROR in fixed radius graph: {e}")

    # 5. Green space contiguity
    try:
        green_G = analysis_contiguity(green)
        if green_G:
            results["green_contiguity"] = {"nodes": green_G.number_of_nodes(), "edges": green_G.number_of_edges()}
    except Exception as e:
        print(f"  ERROR in contiguity: {e}")

    # 6. Full morphological graph (smaller sample)
    try:
        morph_G = analysis_morphological(buildings, roads, limit=1000)
        results["morphological_graph"] = {"nodes": morph_G.number_of_nodes(), "edges": morph_G.number_of_edges()}
    except Exception as e:
        print(f"  ERROR in morphological graph: {e}")

    # Save summary
    summary_path = OUT_DIR / "city2graph_summary.json"
    with open(summary_path, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")
    for name, data in results.items():
        print(f"  {name}: {data}")
    print(f"\nResults saved to: {OUT_DIR}")
    print("Done.")


if __name__ == "__main__":
    main()
