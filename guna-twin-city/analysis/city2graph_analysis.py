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

    # Ensure all geometries are Polygons (filter out Points/Lines)
    buildings_proj = buildings_proj[
        buildings_proj.geometry.geom_type.isin(["Polygon", "MultiPolygon"])
    ].reset_index(drop=True)
    print(f"  Polygon buildings: {len(buildings_proj)}")

    # Roads as barriers creates enclosed tessellation but is very memory-heavy.
    # Skip barriers to use simple morphological tessellation (Voronoi).
    barriers = None
    print("  Using morphological tessellation (Voronoi around buildings)")

    print("  Creating tessellation...")
    tess = city2graph.create_tessellation(
        buildings_proj,
        primary_barriers=barriers,
        shrink=0.4,
        segment=0.5,
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

    # Step 1: Convert segments to a primal graph (nodes=intersections, edges=streets)
    print("  Building primal graph from segments...")
    primal_graph = city2graph.segments_to_graph(drivable_proj, as_nx=False)
    nodes_gdf, edges_gdf = primal_graph
    print(f"    Primal graph: {len(nodes_gdf)} nodes, {len(edges_gdf)} edges")

    # Step 2: Build dual graph (nodes=streets, edges=shared intersections)
    print("  Building dual graph...")
    G = city2graph.dual_graph(primal_graph, as_nx=True)

    print(f"    Dual nodes (street segments): {G.number_of_nodes()}")
    print(f"    Dual edges (intersections): {G.number_of_edges()}")

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
    nodes_gdf, edges_gdf = city2graph.knn_graph(buildings_proj, k=k)

    print(f"    Nodes: {len(nodes_gdf)}")
    print(f"    Edges: {len(edges_gdf)}")

    # Analyze edge distances (edges_gdf has geometry = LineString between centroids)
    if "weight" in edges_gdf.columns:
        distances = edges_gdf["weight"].dropna()
        print(f"    Avg neighbor distance: {distances.mean():.1f}m")
        print(f"    Max neighbor distance: {distances.max():.1f}m")
        print(f"    Median neighbor distance: {distances.median():.1f}m")
    elif len(edges_gdf) > 0:
        # Compute distances from edge geometries
        distances = edges_gdf.geometry.length
        print(f"    Avg neighbor distance: {distances.mean():.1f}m")
        print(f"    Max neighbor distance: {distances.max():.1f}m")
        print(f"    Median neighbor distance: {distances.median():.1f}m")

    # Save edges for visualization
    edges_wgs = edges_gdf.to_crs(epsg=4326)
    out_path = OUT_DIR / "knn_edges_guna.geojson"
    edges_wgs.to_file(out_path, driver="GeoJSON")
    print(f"    Saved: {out_path.name}")

    return nodes_gdf, edges_gdf


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
    nodes_gdf, edges_gdf = city2graph.fixed_radius_graph(buildings_proj, radius=radius)

    print(f"    Nodes: {len(nodes_gdf)}")
    print(f"    Edges: {len(edges_gdf)}")

    # Compute degree from edges
    if len(edges_gdf) > 0 and "source" in edges_gdf.columns and "target" in edges_gdf.columns:
        from collections import Counter
        degree_counts = Counter()
        for _, row in edges_gdf.iterrows():
            degree_counts[row["source"]] += 1
            degree_counts[row["target"]] += 1
        degrees = list(degree_counts.values())
    else:
        # Convert to nx to get degrees
        G_nx = city2graph.gdf_to_nx(nodes_gdf, edges_gdf)
        degrees = [d for _, d in G_nx.degree()]

    if degrees:
        print(f"    Avg degree: {np.mean(degrees):.1f}")
        print(f"    Max degree: {max(degrees)} (densest cluster)")
        dense_count = sum(1 for d in degrees if d > np.mean(degrees) + 2 * np.std(degrees))
        print(f"    Dense clusters (>2 std): {dense_count} buildings")

    return nodes_gdf, edges_gdf


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

    # Queen contiguity: polygons sharing any boundary point are connected
    print("  Building contiguity graph (Queen adjacency)...")
    nodes_gdf, edges_gdf = city2graph.contiguity_graph(green_proj, contiguity="queen")

    print(f"    Nodes (green spaces): {len(nodes_gdf)}")
    print(f"    Edges (adjacencies): {len(edges_gdf)}")

    if len(edges_gdf) > 0:
        import networkx as nx
        G = city2graph.gdf_to_nx(nodes_gdf, edges_gdf)
        components = list(nx.connected_components(G))
        print(f"    Green corridors (connected components): {len(components)}")
        print(f"    Largest corridor: {max(len(c) for c in components)} spaces")

    return nodes_gdf, edges_gdf


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

    # morphological_graph returns (nodes_dict, edges_dict) by default
    # nodes_dict: {type_name: GeoDataFrame}
    # edges_dict: {(src_type, edge_type, tgt_type): GeoDataFrame}
    nodes_dict, edges_dict = city2graph.morphological_graph(
        buildings_proj,
        roads_proj,
    )

    # Analyze heterogeneous graph
    print(f"    Node types:")
    total_nodes = 0
    for ntype, ndf in nodes_dict.items():
        print(f"      {ntype}: {len(ndf)}")
        total_nodes += len(ndf)
    print(f"    Total nodes: {total_nodes}")

    print(f"    Edge types:")
    total_edges = 0
    for etype, edf in edges_dict.items():
        print(f"      {etype}: {len(edf)}")
        total_edges += len(edf)
    print(f"    Total edges: {total_edges}")

    # Convert to NetworkX for further analysis
    G = city2graph.gdf_to_nx(nodes_dict, edges_dict)
    print(f"    NetworkX graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    return nodes_dict, edges_dict, G


# ═══════════════════════════════════════
# VISUALIZATION
# ═══════════════════════════════════════

def generate_morphology_map(tess_gdf):
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
# ANALYSIS 7: Delaunay Triangulation
# ═══════════════════════════════════════

def analysis_delaunay(buildings, limit=None):
    """Delaunay triangulation — connects every building to its natural spatial neighbors."""
    import city2graph

    print("\n[7] DELAUNAY TRIANGULATION GRAPH")

    if limit and len(buildings) > limit:
        print(f"  Sampling {limit} buildings...")
        buildings = buildings.sample(n=limit, random_state=42).reset_index(drop=True)

    buildings_proj = buildings.to_crs(epsg=32643)

    print("  Building Delaunay graph...")
    nodes_gdf, edges_gdf = city2graph.delaunay_graph(buildings_proj)

    print(f"    Nodes: {len(nodes_gdf)}")
    print(f"    Edges: {len(edges_gdf)}")

    if len(edges_gdf) > 0:
        lengths = edges_gdf.geometry.length
        print(f"    Avg edge length: {lengths.mean():.1f}m")
        print(f"    Max edge length: {lengths.max():.1f}m")

    return nodes_gdf, edges_gdf


# ═══════════════════════════════════════
# ANALYSIS 8: Metapath Analysis
# ═══════════════════════════════════════

def analysis_metapaths(morph_nodes, morph_edges):
    """Compute metapaths: building -> street -> building connectivity."""
    import city2graph

    print("\n[8] METAPATH ANALYSIS (building-street-building)")

    # Metapath: private -[faced_to]-> public -[faced_to]-> private
    # This finds buildings connected through the same street
    print("  Computing building-street-building metapaths...")
    new_nodes, new_edges = city2graph.add_metapaths(
        nodes=morph_nodes,
        edges=morph_edges,
        sequence=[
            ("private", "faced_to", "public"),
            ("public", "faced_to", "private"),
        ],
        new_relation_name="shares_street_with",
        directed=False,
    )

    # Check for the new edge type
    meta_key = None
    for key, edf in new_edges.items():
        if "shares_street_with" in str(key):
            meta_key = key
            break

    if meta_key and len(new_edges[meta_key]) > 0:
        meta_edges = new_edges[meta_key]
        print(f"    Building-to-building via shared street: {len(meta_edges)} connections")

        # This tells us which buildings face each other across a street
        # High connectivity = commercial corridor, low = residential dead-ends
    else:
        print("    No metapath edges generated")

    return new_nodes, new_edges


# ═══════════════════════════════════════
# ANALYSIS 9: Graph-based Isochrone
# ═══════════════════════════════════════

def analysis_isochrone(morph_nodes, morph_edges, center_lat=24.642, center_lon=77.310):
    """Compute walking isochrones from old city center using the morphological graph."""
    import city2graph
    from shapely.geometry import Point
    from pyproj import Transformer

    print("\n[9] GRAPH-BASED ISOCHRONE (old city center)")

    # Convert center to projected CRS
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
    cx, cy = transformer.transform(center_lon, center_lat)
    center = Point(cx, cy)

    # Convert morph graph to NetworkX for isochrone
    G = city2graph.gdf_to_nx(morph_nodes, morph_edges)

    # Walking isochrones: 300m, 600m, 1000m (roughly 5, 10, 15 min walk)
    thresholds = [300, 600, 1000]
    print(f"  Computing isochrones at {thresholds}m from center...")

    iso_gdf = city2graph.create_isochrone(
        graph=G,
        center_point=center,
        threshold=thresholds,
        edge_attr="length",
    )

    print(f"    Isochrone zones generated: {len(iso_gdf)}")

    # Save as GeoJSON
    if len(iso_gdf) > 0:
        iso_wgs = iso_gdf.to_crs(epsg=4326)
        out_path = OUT_DIR / "isochrone_guna.geojson"
        iso_wgs.to_file(out_path, driver="GeoJSON")
        print(f"    Saved: {out_path.name}")

    return iso_gdf


# ═══════════════════════════════════════
# ANALYSIS 10: POI Grouping into Cells
# ═══════════════════════════════════════

def analysis_poi_grouping(tess, pois):
    """Group POIs into tessellation cells — which buildings have amenity access."""
    import city2graph

    print("\n[10] POI GROUPING INTO TESSELLATION CELLS")

    if len(pois) < 2:
        print("  Not enough POIs for grouping")
        return None

    # Ensure both are in projected CRS
    tess_proj = tess if tess.crs.to_epsg() == 32643 else tess.to_crs(epsg=32643)
    pois_proj = pois.to_crs(epsg=32643)

    # Ensure POIs are Points
    pois_pts = pois_proj[pois_proj.geometry.geom_type == "Point"].reset_index(drop=True)
    if len(pois_pts) < 2:
        print("  Not enough Point POIs for grouping")
        return None

    print(f"  Grouping {len(pois_pts)} POIs into {len(tess_proj)} tessellation cells...")
    nodes_dict, edges_dict = city2graph.group_nodes(
        tess_proj, pois_pts, predicate="intersects"
    )

    for ntype, ndf in nodes_dict.items():
        print(f"    {ntype} nodes: {len(ndf)}")
    for etype, edf in edges_dict.items():
        print(f"    {etype} edges: {len(edf)}")

    return nodes_dict, edges_dict


# ═══════════════════════════════════════
# ANALYSIS 11: Clean Graph (remove isolates)
# ═══════════════════════════════════════

def analysis_clean_dual(roads):
    """Build street graph and remove isolated components for a clean network."""
    import city2graph
    import networkx as nx

    print("\n[11] CLEANED STREET NETWORK (isolated components removed)")

    drivable = roads[roads["highway"].isin([
        "trunk", "primary", "secondary", "tertiary",
        "residential", "unclassified", "living_street",
    ])].copy()
    drivable_proj = drivable.to_crs(epsg=32643)

    # Build primal graph
    primal = city2graph.segments_to_graph(drivable_proj, as_nx=False)

    # Remove isolated components
    clean_nodes, clean_edges = city2graph.remove_isolated_components(primal)

    print(f"    Original: {len(primal[0])} nodes, {len(primal[1])} edges")
    print(f"    Cleaned:  {len(clean_nodes)} nodes, {len(clean_edges)} edges")
    print(f"    Removed:  {len(primal[0]) - len(clean_nodes)} isolated nodes")

    # Save cleaned network
    clean_edges_wgs = clean_edges.to_crs(epsg=4326)
    out_path = OUT_DIR / "clean_street_network_guna.geojson"
    clean_edges_wgs.to_file(out_path, driver="GeoJSON")
    print(f"    Saved: {out_path.name}")

    return clean_nodes, clean_edges


# ═══════════════════════════════════════
# ANALYSIS 12: Publication-Quality Plots
# ═══════════════════════════════════════

def analysis_plots(morph_nodes, morph_edges, knn_nodes=None, knn_edges=None):
    """Generate matplotlib plots using city2graph's built-in plot_graph."""
    import city2graph
    import matplotlib
    matplotlib.use("Agg")  # Non-interactive backend
    import matplotlib.pyplot as plt

    print("\n[12] GENERATING PUBLICATION PLOTS")

    # Plot morphological graph
    print("  Plotting morphological graph...")
    try:
        ax = city2graph.plot_graph(
            nodes=morph_nodes,
            edges=morph_edges,
            figsize=(14, 14),
            bgcolor="#0a0a1a",
        )
        fig = ax.get_figure() if not isinstance(ax, np.ndarray) else ax.flat[0].get_figure()
        fig.savefig(OUT_DIR / "morphological_graph.png", dpi=150, bbox_inches="tight",
                    facecolor="#0a0a1a")
        plt.close(fig)
        print("    Saved: morphological_graph.png")
    except Exception as e:
        print(f"    Plot error: {e}")

    # Plot KNN graph
    if knn_nodes is not None:
        print("  Plotting KNN proximity graph...")
        try:
            ax = city2graph.plot_graph(
                nodes={"buildings": knn_nodes},
                edges={("buildings", "knn", "buildings"): knn_edges},
                figsize=(14, 14),
                bgcolor="#0a0a1a",
                node_color="#00e5ff",
                edge_color="#7c4dff",
            )
            fig = ax.get_figure() if not isinstance(ax, np.ndarray) else ax.flat[0].get_figure()
            fig.savefig(OUT_DIR / "knn_graph.png", dpi=150, bbox_inches="tight",
                        facecolor="#0a0a1a")
            plt.close(fig)
            print("    Saved: knn_graph.png")
        except Exception as e:
            print(f"    Plot error: {e}")


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
    green = load_green_spaces(bbox=OLD_CITY)

    results = {}

    # 1. Tessellation — NOTE: momepy's morphological_tessellation has a
    # shapely coverage_simplify bug with some geometry types. Using the
    # tessellation embedded inside morphological_graph (analysis 6) instead.
    print("\n[1] MORPHOLOGICAL TESSELLATION")
    print("  Skipped (using tessellation from morphological_graph in step 6)")

    # 2. Street dual graph
    try:
        street_G = analysis_street_graph(roads)
        results["street_graph"] = {"nodes": street_G.number_of_nodes(), "edges": street_G.number_of_edges()}
    except Exception as e:
        print(f"  ERROR in street graph: {e}")
        import traceback; traceback.print_exc()

    # 3. Building KNN proximity
    try:
        knn_nodes, knn_edges = analysis_building_proximity(buildings, k=6, limit=3000)
        results["knn_graph"] = {"nodes": len(knn_nodes), "edges": len(knn_edges)}
    except Exception as e:
        print(f"  ERROR in KNN graph: {e}")
        import traceback; traceback.print_exc()

    # 4. Fixed radius graph
    try:
        fr_nodes, fr_edges = analysis_fixed_radius(buildings, radius=50, limit=3000)
        results["fixed_radius_graph"] = {"nodes": len(fr_nodes), "edges": len(fr_edges)}
    except Exception as e:
        print(f"  ERROR in fixed radius graph: {e}")
        import traceback; traceback.print_exc()

    # 5. Green space contiguity
    try:
        result = analysis_contiguity(green)
        if result is not None:
            green_nodes, green_edges = result
            results["green_contiguity"] = {"nodes": len(green_nodes), "edges": len(green_edges)}
    except Exception as e:
        print(f"  ERROR in contiguity: {e}")
        import traceback; traceback.print_exc()

    # 6. Full morphological graph (smaller sample)
    try:
        morph_nodes, morph_edges, morph_G = analysis_morphological(buildings, roads, limit=1000)
        results["morphological_graph"] = {"nodes": morph_G.number_of_nodes(), "edges": morph_G.number_of_edges()}
    except Exception as e:
        print(f"  ERROR in morphological graph: {e}")
        import traceback; traceback.print_exc()

    # 7. Delaunay triangulation
    try:
        del_nodes, del_edges = analysis_delaunay(buildings, limit=3000)
        results["delaunay_graph"] = {"nodes": len(del_nodes), "edges": len(del_edges)}
    except Exception as e:
        print(f"  ERROR in Delaunay graph: {e}")
        import traceback; traceback.print_exc()

    # 8. Metapath analysis (requires morphological graph from #6)
    if "morphological_graph" in results:
        try:
            meta_nodes, meta_edges = analysis_metapaths(morph_nodes, morph_edges)
            meta_key = [k for k in meta_edges if "shares_street_with" in str(k)]
            if meta_key:
                results["metapaths_building_street"] = {"edges": len(meta_edges[meta_key[0]])}
        except Exception as e:
            print(f"  ERROR in metapaths: {e}")
            import traceback; traceback.print_exc()

    # 9. Graph-based isochrone — skipped (concave hull computation uses too much memory)
    print("\n[9] GRAPH-BASED ISOCHRONE")
    print("  Skipped (concave hull computation too memory-intensive for this graph size)")

    # 10. POI grouping — skipped (tessellation not available, and only 11 POIs)
    print("\n[10] POI GROUPING")
    print("  Skipped (tessellation not available)")

    # 11. Cleaned street network
    try:
        clean_nodes, clean_edges = analysis_clean_dual(roads)
        results["clean_street_network"] = {"nodes": len(clean_nodes), "edges": len(clean_edges)}
    except Exception as e:
        print(f"  ERROR in clean network: {e}")
        import traceback; traceback.print_exc()

    # 12. Publication plots (requires morphological + KNN)
    if "morphological_graph" in results:
        try:
            knn_n = knn_nodes if "knn_graph" in results else None
            knn_e = knn_edges if "knn_graph" in results else None
            analysis_plots(morph_nodes, morph_edges, knn_n, knn_e)
            results["plots"] = {"generated": True}
        except Exception as e:
            print(f"  ERROR in plots: {e}")
            import traceback; traceback.print_exc()

    # Save summary
    summary_path = OUT_DIR / "city2graph_summary.json"
    with open(summary_path, "w") as f:
        json.dump(results, f, indent=2, default=lambda x: float(x) if hasattr(x, 'item') else x)

    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")
    for name, data in results.items():
        print(f"  {name}: {data}")
    print(f"\nResults saved to: {OUT_DIR}")
    print("Done.")


if __name__ == "__main__":
    main()
