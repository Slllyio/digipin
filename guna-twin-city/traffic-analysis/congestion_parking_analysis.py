#!/usr/bin/env python3
"""
Guna Traffic Solutions — Congestion Hotspot + Parking Pressure Analysis
=======================================================================
1. Re-runs SUMO with edge-level output (edgeData) to identify bottleneck streets
2. Queries OSM Overpass for parking infrastructure in Guna
3. Generates an interactive HTML map with both layers

Usage:
    python congestion_parking_analysis.py              # run all
    python congestion_parking_analysis.py --congestion  # congestion only
    python congestion_parking_analysis.py --parking      # parking only
"""

import argparse
import json
import subprocess
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import requests

WORK_DIR = Path(__file__).parent
SUMO_DIR = WORK_DIR / "sumo"
OUT_DIR = WORK_DIR
CITY_NAME = "guna"

# Guna bbox
BBOX = {"south": 24.58, "west": 77.25, "north": 24.70, "east": 77.38}
CENTER = [24.6354, 77.3126]


# ═══════════════════════════════════════════════════════════
# PART 1: CONGESTION HOTSPOT ANALYSIS (SUMO edge-level data)
# ═══════════════════════════════════════════════════════════

def create_edgedata_additional(output_file, edgedata_output, interval=300):
    """Create SUMO additional file that enables edge-level data collection."""
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<additional>
    <edgeData id="edge_dump" file="{edgedata_output.name}" freq="{interval}"
              excludeEmpty="true" withInternal="false"/>
</additional>
"""
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"  Edge data config: {output_file.name} (interval={interval}s)")


def run_sumo_with_edgedata(scenario="baseline"):
    """Re-run SUMO simulation with edge-level output enabled."""
    if scenario == "baseline":
        net_file = SUMO_DIR / f"{CITY_NAME}.net.xml"
        rou_file = SUMO_DIR / f"{CITY_NAME}.rou.xml"
    elif scenario == "oneway":
        net_file = SUMO_DIR / f"{CITY_NAME}_oneway.net.xml"
        rou_file = SUMO_DIR / f"{CITY_NAME}_oneway.rou.xml"
    elif scenario == "hd_baseline":
        net_file = SUMO_DIR / f"{CITY_NAME}.net.xml"
        rou_file = SUMO_DIR / f"{CITY_NAME}_hd_baseline.rou.xml"
    else:
        net_file = SUMO_DIR / f"{CITY_NAME}_oneway.net.xml"
        rou_file = SUMO_DIR / f"{CITY_NAME}_hd_oneway.rou.xml"

    edgedata_out = SUMO_DIR / f"edgedata_{scenario}.xml"
    additional = SUMO_DIR / f"additional_{scenario}.xml"

    if not net_file.exists() or not rou_file.exists():
        print(f"  SKIP {scenario}: network or route file missing")
        return None

    if edgedata_out.exists():
        print(f"  Already exists: {edgedata_out.name}")
        return edgedata_out

    create_edgedata_additional(additional, edgedata_out)

    cmd = [
        "sumo", "--no-warnings",
        "-n", str(net_file),
        "-r", str(rou_file),
        "-a", str(additional),
        "--begin", "0", "--end", "3600", "--step-length", "0.5",
        "--lateral-resolution", "0.5",
        "--no-step-log", "true",
        "--ignore-route-errors", "true",
    ]

    print(f"  Running SUMO ({scenario}) with edge output...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        print(f"  SUMO error: {result.stderr[:300]}")
        return None

    print(f"  Edge data saved: {edgedata_out.name}")
    return edgedata_out


def parse_edgedata(edgedata_file):
    """Parse SUMO edgeData XML -> per-edge aggregated metrics."""
    tree = ET.parse(edgedata_file)
    root = tree.getroot()

    edge_stats = defaultdict(lambda: {
        "speeds": [], "densities": [], "occupancies": [],
        "entered": 0, "left": 0, "waiting_times": [],
        "time_losses": [], "samples": 0,
    })

    for interval in root.findall("interval"):
        for edge in interval.findall("edge"):
            eid = edge.get("id", "")
            if eid.startswith(":"):
                continue

            stats = edge_stats[eid]
            stats["samples"] += 1
            stats["entered"] += int(float(edge.get("entered", 0)))
            stats["left"] += int(float(edge.get("left", 0)))

            speed = float(edge.get("speed", -1))
            if speed >= 0:
                stats["speeds"].append(speed)

            density = float(edge.get("density", 0))
            stats["densities"].append(density)

            occ = float(edge.get("occupancy", 0))
            stats["occupancies"].append(occ)

            wt = float(edge.get("waitingTime", 0))
            stats["waiting_times"].append(wt)

            tl = float(edge.get("timeLoss", 0))
            stats["time_losses"].append(tl)

    results = {}
    for eid, s in edge_stats.items():
        avg_speed_ms = sum(s["speeds"]) / len(s["speeds"]) if s["speeds"] else 0
        avg_speed_kmh = avg_speed_ms * 3.6
        avg_density = sum(s["densities"]) / len(s["densities"]) if s["densities"] else 0
        avg_occ = sum(s["occupancies"]) / len(s["occupancies"]) if s["occupancies"] else 0
        total_waiting = sum(s["waiting_times"])
        total_timeloss = sum(s["time_losses"])

        results[eid] = {
            "avg_speed_kmh": round(avg_speed_kmh, 1),
            "avg_density": round(avg_density, 2),
            "avg_occupancy": round(avg_occ, 2),
            "total_vehicles": s["entered"],
            "total_waiting_s": round(total_waiting, 1),
            "total_timeloss_s": round(total_timeloss, 1),
            "samples": s["samples"],
        }

    return results


def get_edge_geometries(net_file):
    """Extract edge geometries (lat/lon) from SUMO network using sumolib."""
    try:
        import sumolib
    except ImportError:
        print("  sumolib not available -- skipping geometry extraction")
        return {}

    net = sumolib.net.readNet(str(net_file), withInternal=False)
    geometries = {}

    for edge in net.getEdges():
        eid = edge.getID()
        if eid.startswith(":"):
            continue
        shape = edge.getShape()
        coords = []
        for x, y in shape:
            lon, lat = net.convertXY2LonLat(x, y)
            coords.append([lat, lon])
        geometries[eid] = {
            "coords": coords,
            "length_m": round(edge.getLength(), 1),
            "speed_limit_kmh": round(edge.getSpeed() * 3.6, 1),
            "lanes": edge.getLaneNumber(),
            "name": edge.getName() or eid,
        }

    return geometries


def identify_hotspots(edge_metrics, edge_geoms, top_n=30):
    """Score edges by congestion severity and return top hotspots."""
    scored = []

    for eid, m in edge_metrics.items():
        if m["total_vehicles"] < 5:
            continue
        if eid not in edge_geoms:
            continue

        geom = edge_geoms[eid]
        speed_limit = geom["speed_limit_kmh"]
        actual_speed = m["avg_speed_kmh"]

        speed_ratio = actual_speed / speed_limit if speed_limit > 0 else 1
        speed_penalty = max(0, 1 - speed_ratio)

        wait_per_veh = m["total_waiting_s"] / m["total_vehicles"] if m["total_vehicles"] > 0 else 0
        loss_per_veh = m["total_timeloss_s"] / m["total_vehicles"] if m["total_vehicles"] > 0 else 0
        volume_factor = min(m["total_vehicles"] / 50, 2.0)

        congestion_score = (
            speed_penalty * 40 +
            min(wait_per_veh, 30) * 1.5 +
            min(loss_per_veh, 60) * 0.8 +
            m["avg_occupancy"] * 20
        ) * volume_factor

        scored.append({
            "edge_id": eid,
            "name": geom["name"],
            "congestion_score": round(congestion_score, 1),
            "avg_speed_kmh": actual_speed,
            "speed_limit_kmh": speed_limit,
            "speed_ratio": round(speed_ratio, 2),
            "total_vehicles": m["total_vehicles"],
            "total_waiting_s": m["total_waiting_s"],
            "wait_per_vehicle_s": round(wait_per_veh, 1),
            "timeloss_per_vehicle_s": round(loss_per_veh, 1),
            "avg_occupancy": m["avg_occupancy"],
            "length_m": geom["length_m"],
            "lanes": geom["lanes"],
            "coords": geom["coords"],
        })

    scored.sort(key=lambda x: x["congestion_score"], reverse=True)
    return scored[:top_n]


def run_congestion_analysis():
    """Full congestion hotspot pipeline."""
    print("\n" + "=" * 60)
    print("CONGESTION HOTSPOT ANALYSIS")
    print("=" * 60)

    scenarios = {}
    for scenario in ["baseline", "hd_baseline"]:
        edgedata_file = run_sumo_with_edgedata(scenario)
        if edgedata_file and edgedata_file.exists():
            print(f"  Parsing {scenario} edge data...")
            scenarios[scenario] = parse_edgedata(edgedata_file)
            print(f"    {len(scenarios[scenario])} edges with data")

    if not scenarios:
        print("  ERROR: No edge data generated. Check SUMO installation.")
        return None

    net_file = SUMO_DIR / f"{CITY_NAME}.net.xml"
    print("  Loading network geometries...")
    edge_geoms = get_edge_geometries(net_file)
    print(f"    {len(edge_geoms)} edge geometries loaded")

    all_hotspots = {}
    for scenario, metrics in scenarios.items():
        hotspots = identify_hotspots(metrics, edge_geoms, top_n=30)
        all_hotspots[scenario] = hotspots
        print(f"\n  Top congestion hotspots ({scenario}):")
        for i, h in enumerate(hotspots[:10], 1):
            print(f"    {i:2d}. {h['name'][:35]:35s} score={h['congestion_score']:5.1f}  "
                  f"speed={h['avg_speed_kmh']:4.1f}/{h['speed_limit_kmh']:4.1f} km/h  "
                  f"vol={h['total_vehicles']:3d}  wait={h['wait_per_vehicle_s']:.1f}s/veh")

    out_path = OUT_DIR / "congestion_hotspots.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(all_hotspots, f, indent=2)
    print(f"\n  Saved: {out_path.name}")

    return all_hotspots


# ═══════════════════════════════════════════════════════════
# PART 2: PARKING PRESSURE ANALYSIS (OSM Overpass)
# ═══════════════════════════════════════════════════════════

def query_overpass_parking():
    """Query OSM Overpass API for all parking-related features in Guna."""
    print("\n" + "=" * 60)
    print("PARKING PRESSURE ANALYSIS (OSM)")
    print("=" * 60)

    bbox_str = f"{BBOX['south']},{BBOX['west']},{BBOX['north']},{BBOX['east']}"

    query = f"""
[out:json][timeout:60];
(
  node["amenity"="parking"]({bbox_str});
  way["amenity"="parking"]({bbox_str});
  relation["amenity"="parking"]({bbox_str});
  node["amenity"="bicycle_parking"]({bbox_str});
  node["amenity"="motorcycle_parking"]({bbox_str});
  node["amenity"="parking_entrance"]({bbox_str});
  way["parking:lane:both"~"."]({bbox_str});
  way["parking:lane:right"~"."]({bbox_str});
  way["parking:lane:left"~"."]({bbox_str});
  way["parking:lane"~"."]({bbox_str});
  way["parking:condition"~"."]({bbox_str});
  node["amenity"="fuel"]({bbox_str});
  way["amenity"="fuel"]({bbox_str});
  node["highway"="bus_stop"]({bbox_str});
  node["amenity"="marketplace"]({bbox_str});
  way["amenity"="marketplace"]({bbox_str});
  way["landuse"="retail"]({bbox_str});
  way["landuse"="commercial"]({bbox_str});
  node["amenity"="hospital"]({bbox_str});
  way["amenity"="hospital"]({bbox_str});
  node["amenity"="school"]({bbox_str});
  way["amenity"="school"]({bbox_str});
  node["amenity"="place_of_worship"]({bbox_str});
  way["amenity"="place_of_worship"]({bbox_str});
  way["highway"~"primary|secondary|tertiary"]["name"~"."]({bbox_str});
);
out body geom;
"""

    print("  Querying Overpass API...")
    url = "https://overpass-api.de/api/interpreter"
    resp = requests.post(url, data={"data": query}, timeout=120)
    resp.raise_for_status()
    data = resp.json()

    elements = data.get("elements", [])
    print(f"  Received {len(elements)} elements")

    return elements


def classify_parking_elements(elements):
    """Classify OSM elements into parking supply, demand generators, and road segments."""
    supply = []
    demand = []
    roads = []
    bus_stops = []
    fuel = []

    for el in elements:
        tags = el.get("tags", {})
        etype = el.get("type", "")
        amenity = tags.get("amenity", "")
        highway = tags.get("highway", "")
        landuse = tags.get("landuse", "")

        if etype == "node":
            lat, lon = el.get("lat", 0), el.get("lon", 0)
        elif etype == "way" and "geometry" in el:
            geom = el["geometry"]
            lat = sum(p["lat"] for p in geom) / len(geom)
            lon = sum(p["lon"] for p in geom) / len(geom)
        else:
            lat, lon = el.get("lat", 0), el.get("lon", 0)

        entry = {
            "id": el.get("id"),
            "type": etype,
            "lat": lat, "lon": lon,
            "tags": tags,
            "name": tags.get("name", tags.get("name:en", "")),
        }

        if amenity in ("parking", "bicycle_parking", "motorcycle_parking", "parking_entrance"):
            entry["category"] = amenity
            entry["capacity"] = tags.get("capacity", "unknown")
            entry["access"] = tags.get("access", "unknown")
            entry["fee"] = tags.get("fee", "unknown")
            entry["surface"] = tags.get("surface", "unknown")
            supply.append(entry)
        elif amenity == "fuel":
            entry["category"] = "fuel_station"
            fuel.append(entry)
        elif amenity in ("hospital", "school", "place_of_worship", "marketplace"):
            entry["category"] = amenity
            demand.append(entry)
        elif landuse in ("retail", "commercial"):
            entry["category"] = f"landuse_{landuse}"
            demand.append(entry)
        elif highway == "bus_stop":
            entry["category"] = "bus_stop"
            bus_stops.append(entry)
        elif highway in ("primary", "secondary", "tertiary") and tags.get("name"):
            entry["category"] = highway
            entry["road_name"] = tags.get("name", "")
            has_parking = any(k.startswith("parking:") for k in tags)
            entry["has_parking_tags"] = has_parking
            if etype == "way" and "geometry" in el:
                entry["geometry"] = [[p["lat"], p["lon"]] for p in el["geometry"]]
            roads.append(entry)

    return {
        "supply": supply,
        "demand_generators": demand,
        "roads": roads,
        "bus_stops": bus_stops,
        "fuel_stations": fuel,
    }


def compute_parking_pressure(classified):
    """Compute parking pressure scores per road based on supply vs demand."""
    from math import radians, sin, cos, sqrt, atan2

    supply = classified["supply"]
    demand = classified["demand_generators"]
    roads = classified["roads"]
    bus_stops = classified["bus_stops"]

    print(f"\n  Parking Supply:")
    print(f"    Parking lots/areas: {sum(1 for s in supply if s['category'] == 'parking')}")
    print(f"    Bicycle parking: {sum(1 for s in supply if s['category'] == 'bicycle_parking')}")
    print(f"    Motorcycle parking: {sum(1 for s in supply if s['category'] == 'motorcycle_parking')}")
    print(f"    Fuel stations: {len(classified['fuel_stations'])}")

    print(f"\n  Parking Demand Generators:")
    for cat in ("hospital", "school", "place_of_worship", "marketplace",
                "landuse_retail", "landuse_commercial"):
        count = sum(1 for d in demand if d["category"] == cat)
        if count > 0:
            print(f"    {cat}: {count}")

    print(f"\n  Road Infrastructure:")
    print(f"    Named road segments: {len(roads)}")
    print(f"    Bus stops: {len(bus_stops)}")

    def haversine(lat1, lon1, lat2, lon2):
        R = 6371000
        dlat = radians(lat2 - lat1)
        dlon = radians(lon2 - lon1)
        a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
        return R * 2 * atan2(sqrt(a), sqrt(1 - a))

    # Group roads by name
    road_groups = defaultdict(lambda: {"segments": [], "nearby_demand": 0, "nearby_supply": 0})
    for road in roads:
        rname = road.get("road_name", "unnamed")
        road_groups[rname]["segments"].append(road)

    pressure_scores = []
    for rname, rdata in road_groups.items():
        seg = rdata["segments"][0]
        rlat, rlon = seg["lat"], seg["lon"]

        nearby_demand = sum(1 for d in demand if haversine(rlat, rlon, d["lat"], d["lon"]) < 200)
        nearby_supply = sum(1 for s in supply if haversine(rlat, rlon, s["lat"], s["lon"]) < 300)
        nearby_bus = sum(1 for b in bus_stops if haversine(rlat, rlon, b["lat"], b["lon"]) < 100)

        pressure = (nearby_demand * 15) - (nearby_supply * 10) + (nearby_bus * 5)
        road_type = seg.get("category", "tertiary")
        type_weight = {"primary": 1.5, "secondary": 1.2, "tertiary": 1.0}.get(road_type, 1.0)
        pressure = max(0, pressure * type_weight)

        all_coords = []
        for s in rdata["segments"]:
            if "geometry" in s:
                all_coords.extend(s["geometry"])

        pressure_scores.append({
            "road_name": rname,
            "road_type": road_type,
            "pressure_score": round(pressure, 1),
            "nearby_demand": nearby_demand,
            "nearby_supply": nearby_supply,
            "nearby_bus_stops": nearby_bus,
            "segment_count": len(rdata["segments"]),
            "lat": rlat, "lon": rlon,
            "coords": all_coords[:50],
        })

    pressure_scores.sort(key=lambda x: x["pressure_score"], reverse=True)

    print(f"\n  Top Parking Pressure Zones:")
    for i, p in enumerate(pressure_scores[:15], 1):
        print(f"    {i:2d}. {p['road_name'][:35]:35s} pressure={p['pressure_score']:5.1f}  "
              f"demand={p['nearby_demand']}  supply={p['nearby_supply']}  bus={p['nearby_bus_stops']}")

    return {
        "pressure_scores": pressure_scores,
        "classified": {
            "supply_count": len(supply),
            "demand_count": len(demand),
            "road_count": len(roads),
            "bus_stop_count": len(bus_stops),
            "fuel_count": len(classified["fuel_stations"]),
        },
        "supply": supply,
        "demand_generators": demand,
        "bus_stops": bus_stops,
        "fuel_stations": classified["fuel_stations"],
    }


def run_parking_analysis():
    """Full parking pressure pipeline."""
    elements = query_overpass_parking()
    classified = classify_parking_elements(elements)
    parking_data = compute_parking_pressure(classified)

    out_path = OUT_DIR / "parking_analysis.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(parking_data, f, indent=2, default=str)
    print(f"\n  Saved: {out_path.name}")

    return parking_data


# ═══════════════════════════════════════════════════════════
# PART 3: INTERACTIVE HTML MAP (safe DOM construction)
# ═══════════════════════════════════════════════════════════

def generate_solutions_map(congestion_data, parking_data):
    """Generate interactive Leaflet map with congestion + parking layers."""
    print("\n" + "=" * 60)
    print("GENERATING TRAFFIC SOLUTIONS MAP")
    print("=" * 60)

    hotspots_json = "[]"
    if congestion_data:
        scenario = "hd_baseline" if "hd_baseline" in congestion_data else "baseline"
        hotspots = congestion_data.get(scenario, [])
        hotspots_json = json.dumps(hotspots)

    supply_json = json.dumps(parking_data.get("supply", []) if parking_data else [])
    demand_json = json.dumps(parking_data.get("demand_generators", []) if parking_data else [])
    pressure_json = json.dumps(parking_data.get("pressure_scores", [])[:20] if parking_data else [])
    bus_json = json.dumps(parking_data.get("bus_stops", []) if parking_data else [])

    # The map JS uses safe DOM methods (createElement/textContent) per security policy
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Guna Traffic Solutions -- Congestion & Parking Analysis</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family: 'Segoe UI', sans-serif; background: #0a0a1a; color: #e0e0e0; }}
#map {{ position: absolute; top: 0; left: 0; right: 420px; bottom: 0; }}
#panel {{ position: absolute; top: 0; right: 0; width: 420px; bottom: 0;
         background: #0d1b2a; overflow-y: auto; padding: 20px;
         border-left: 2px solid #1b2838; }}
h1 {{ font-size: 18px; color: #00e5ff; margin-bottom: 4px; }}
h2 {{ font-size: 14px; color: #7c4dff; margin: 16px 0 8px; border-bottom: 1px solid #1b2838;
     padding-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }}
.sub {{ font-size: 12px; color: #666; margin-bottom: 16px; }}
.stat {{ display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }}
.stat-label {{ color: #aaa; }}
.stat-val {{ color: #00e5ff; font-weight: 600; }}
.section {{ background: #0d2137; border: 1px solid rgba(0,229,255,0.15); border-radius: 10px;
           padding: 14px; margin: 10px 0; }}
.hotspot-item {{ padding: 6px 0; border-bottom: 1px solid #1b2838; font-size: 12px; cursor: pointer; }}
.hotspot-item:hover {{ background: rgba(0,229,255,0.05); }}
.hotspot-rank {{ color: #ff5252; font-weight: 700; width: 24px; display: inline-block; }}
.hotspot-name {{ color: #e0e0e0; }}
.hotspot-score {{ float: right; color: #ff9800; font-weight: 600; }}
.legend {{ margin-top: 8px; }}
.leg {{ display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px; }}
.leg-box {{ width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; }}
.leg-line {{ width: 24px; height: 4px; border-radius: 2px; flex-shrink: 0; }}
.note {{ font-size: 11px; color: #666; margin-top: 8px; line-height: 1.6; }}
.tab-bar {{ display: flex; gap: 4px; margin: 12px 0; }}
.tab {{ padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
       cursor: pointer; border: 1px solid #1b2838; background: #0d1b2a; color: #888; }}
.tab.active {{ background: rgba(0,229,255,0.1); color: #00e5ff; border-color: #00e5ff; }}
#click-info {{ font-size: 12px; color: #ccc; margin-top: 8px; padding: 10px;
              background: rgba(0,0,0,0.3); border-radius: 8px; min-height: 40px; }}
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
    <h1>Guna Traffic Solutions</h1>
    <div class="sub">Congestion Hotspots + Parking Pressure Analysis</div>
    <div class="tab-bar" id="tab-bar"></div>
    <div id="tab-congestion"></div>
    <div id="tab-parking" style="display:none"></div>
    <h2>Click Details</h2>
    <div id="click-info">Click any element on the map for details.</div>
</div>

<script>
var map = L.map('map').setView([{CENTER[0]}, {CENTER[1]}], 14);
L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}@2x.png', {{
    attribution: '&copy; CARTO &copy; OSM', maxZoom: 19
}}).addTo(map);

var hotspots = {hotspots_json};
var supply = {supply_json};
var demandGen = {demand_json};
var pressureZones = {pressure_json};
var busStops = {bus_json};

var congestionLayer = L.layerGroup().addTo(map);
var parkingSupplyLayer = L.layerGroup();
var parkingDemandLayer = L.layerGroup();
var parkingPressureLayer = L.layerGroup();
var busStopLayer = L.layerGroup();

/* ── Safe DOM helper ── */
function setInfo(lines) {{
    var el = document.getElementById('click-info');
    el.textContent = '';
    lines.forEach(function(line, i) {{
        if (i > 0) el.appendChild(document.createElement('br'));
        var span = document.createElement('span');
        span.textContent = line;
        if (i === 0) {{ span.style.fontWeight = '700'; span.style.color = '#00e5ff'; }}
        el.appendChild(span);
    }});
}}

function buildListItem(rank, name, score, clickFn) {{
    var div = document.createElement('div');
    div.className = 'hotspot-item';
    var r = document.createElement('span'); r.className = 'hotspot-rank'; r.textContent = '#' + rank;
    var n = document.createElement('span'); n.className = 'hotspot-name'; n.textContent = name.substring(0,30);
    var s = document.createElement('span'); s.className = 'hotspot-score'; s.textContent = score;
    div.appendChild(r); div.appendChild(n); div.appendChild(s);
    div.addEventListener('click', clickFn);
    return div;
}}

function addStat(parent, label, valId) {{
    var row = document.createElement('div'); row.className = 'stat';
    var l = document.createElement('span'); l.className = 'stat-label'; l.textContent = label;
    var v = document.createElement('span'); v.className = 'stat-val'; v.id = valId; v.textContent = '--';
    row.appendChild(l); row.appendChild(v);
    parent.appendChild(row);
}}

function addLegend(parent, items) {{
    var lg = document.createElement('div'); lg.className = 'legend';
    items.forEach(function(item) {{
        var row = document.createElement('div'); row.className = 'leg';
        var box = document.createElement('div');
        box.className = item.isLine ? 'leg-line' : 'leg-box';
        box.style.background = item.color;
        if (item.extra) {{ for (var k in item.extra) box.style[k] = item.extra[k]; }}
        var txt = document.createElement('span'); txt.textContent = item.label;
        row.appendChild(box); row.appendChild(txt);
        lg.appendChild(row);
    }});
    parent.appendChild(lg);
}}

/* ── Build tab bar ── */
(function() {{
    var bar = document.getElementById('tab-bar');
    ['Congestion', 'Parking'].forEach(function(name) {{
        var btn = document.createElement('div');
        btn.className = 'tab' + (name === 'Congestion' ? ' active' : '');
        btn.textContent = name;
        btn.addEventListener('click', function() {{
            showTab(name.toLowerCase());
            bar.querySelectorAll('.tab').forEach(function(t) {{ t.classList.remove('active'); }});
            btn.classList.add('active');
        }});
        bar.appendChild(btn);
    }});
}})();

/* ── Build congestion panel ── */
(function() {{
    var panel = document.getElementById('tab-congestion');
    var h = document.createElement('h2'); h.textContent = 'Congestion Hotspots'; panel.appendChild(h);
    var sec = document.createElement('div'); sec.className = 'section';
    addStat(sec, 'Hotspot edges analyzed', 's-hotspots');
    addStat(sec, 'Worst avg speed', 's-worst-speed');
    addStat(sec, 'Max wait/vehicle', 's-max-wait');
    panel.appendChild(sec);
    var h2 = document.createElement('h2'); h2.textContent = 'Top Bottleneck Streets'; panel.appendChild(h2);
    var list = document.createElement('div'); list.id = 'hotspot-list'; panel.appendChild(list);
    var h3 = document.createElement('h2'); h3.textContent = 'Legend'; panel.appendChild(h3);
    addLegend(panel, [
        {{color:'#ff1744',isLine:true,label:'Critical (score > 40)'}},
        {{color:'#ff9100',isLine:true,label:'Severe (20-40)'}},
        {{color:'#ffd600',isLine:true,label:'Moderate (10-20)'}},
        {{color:'#00e676',isLine:true,label:'Low (< 10)'}}
    ]);
}})();

/* ── Build parking panel ── */
(function() {{
    var panel = document.getElementById('tab-parking');
    var h = document.createElement('h2'); h.textContent = 'Parking Supply'; panel.appendChild(h);
    var sec = document.createElement('div'); sec.className = 'section';
    addStat(sec, 'Parking areas', 's-parking');
    addStat(sec, 'Demand generators', 's-demand');
    addStat(sec, 'Bus stops (no-park)', 's-bus');
    panel.appendChild(sec);
    var h2 = document.createElement('h2'); h2.textContent = 'Highest Pressure Zones'; panel.appendChild(h2);
    var list = document.createElement('div'); list.id = 'pressure-list'; panel.appendChild(list);
    var h3 = document.createElement('h2'); h3.textContent = 'Legend'; panel.appendChild(h3);
    addLegend(panel, [
        {{color:'#2196f3',isLine:false,label:'Parking supply (lot/area)'}},
        {{color:'#ff5252',isLine:false,label:'Demand generator (hospital/school/temple)'}},
        {{color:'#ff9800',isLine:true,label:'High parking pressure road'}},
        {{color:'#ffd600',isLine:false,label:'Bus stop (no-parking zone)',extra:{{width:'10px',height:'10px',borderRadius:'50%'}}}}
    ]);
}})();

function congestionColor(score) {{
    if (score > 40) return '#ff1744';
    if (score > 20) return '#ff9100';
    if (score > 10) return '#ffd600';
    return '#00e676';
}}

/* ── Congestion hotspots on map ── */
hotspots.forEach(function(h, i) {{
    if (!h.coords || h.coords.length < 2) return;
    var color = congestionColor(h.congestion_score);
    var w = h.congestion_score > 40 ? 7 : h.congestion_score > 20 ? 5 : 3;
    var line = L.polyline(h.coords, {{ color: color, weight: w, opacity: 0.85 }}).addTo(congestionLayer);
    line.on('click', function() {{
        setInfo([
            h.name,
            'Congestion score: ' + h.congestion_score,
            'Speed: ' + h.avg_speed_kmh + ' / ' + h.speed_limit_kmh + ' km/h',
            'Vehicles: ' + h.total_vehicles,
            'Wait/veh: ' + h.wait_per_vehicle_s + 's',
            'Time loss/veh: ' + h.timeloss_per_vehicle_s + 's',
            'Lanes: ' + h.lanes + ' | Length: ' + h.length_m + 'm'
        ]);
    }});
    if (i < 10) {{
        var mid = h.coords[Math.floor(h.coords.length / 2)];
        L.marker(mid, {{icon: L.divIcon({{
            className: '',
            html: '<div style=\"background:' + color + ';color:#000;font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap\">' + (i+1) + '. ' + h.name.substring(0,20) + '</div>',
            iconSize: [80, 14], iconAnchor: [40, 7]
        }})}}).addTo(congestionLayer);
    }}
}});

document.getElementById('s-hotspots').textContent = hotspots.length;
if (hotspots.length > 0) {{
    var ws = Math.min.apply(null, hotspots.map(function(h) {{ return h.avg_speed_kmh; }}));
    var mw = Math.max.apply(null, hotspots.map(function(h) {{ return h.wait_per_vehicle_s; }}));
    document.getElementById('s-worst-speed').textContent = ws.toFixed(1) + ' km/h';
    document.getElementById('s-max-wait').textContent = mw.toFixed(1) + 's';
}}

var listEl = document.getElementById('hotspot-list');
hotspots.slice(0, 20).forEach(function(h, i) {{
    listEl.appendChild(buildListItem(i+1, h.name, h.congestion_score, function() {{
        if (h.coords && h.coords.length > 0) map.setView(h.coords[0], 16);
    }}));
}});

/* ── Parking supply on map ── */
supply.forEach(function(s) {{
    if (!s.lat || !s.lon) return;
    L.circleMarker([s.lat, s.lon], {{
        radius: 8, fillColor: '#2196f3', fillOpacity: 0.8, color: '#fff', weight: 1
    }}).addTo(parkingSupplyLayer).on('click', function() {{
        setInfo(['Parking: ' + (s.name || s.category),
                 'Type: ' + s.category, 'Capacity: ' + s.capacity,
                 'Access: ' + s.access, 'Fee: ' + s.fee]);
    }});
}});

/* ── Demand generators ── */
demandGen.forEach(function(d) {{
    if (!d.lat || !d.lon) return;
    var icon = d.category === 'hospital' ? '+' : d.category === 'school' ? 'S' :
               d.category === 'place_of_worship' ? 'T' : d.category === 'marketplace' ? 'M' : 'D';
    L.marker([d.lat, d.lon], {{icon: L.divIcon({{
        className: '',
        html: '<div style=\"background:#ff5252;color:#fff;font-size:10px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff\">' + icon + '</div>',
        iconSize: [20, 20], iconAnchor: [10, 10]
    }})}}).addTo(parkingDemandLayer).on('click', function() {{
        setInfo([d.name || d.category, 'Type: ' + d.category,
                 'Generates parking demand in surrounding area']);
    }});
}});

/* ── Parking pressure roads ── */
pressureZones.forEach(function(p) {{
    if (p.coords && p.coords.length >= 2) {{
        var color = p.pressure_score > 30 ? '#ff1744' : p.pressure_score > 15 ? '#ff9800' : '#ffd600';
        L.polyline(p.coords, {{ color: color, weight: 5, opacity: 0.7, dashArray: '10,6' }})
         .addTo(parkingPressureLayer).on('click', function() {{
            setInfo([p.road_name, 'Parking pressure: ' + p.pressure_score,
                     'Demand nearby: ' + p.nearby_demand, 'Supply nearby: ' + p.nearby_supply,
                     'Bus stops nearby: ' + p.nearby_bus_stops]);
        }});
    }}
    L.circleMarker([p.lat, p.lon], {{
        radius: 6, fillColor: '#ff9800', fillOpacity: 0.7, color: '#fff', weight: 1
    }}).addTo(parkingPressureLayer);
}});

/* ── Bus stops ── */
busStops.forEach(function(b) {{
    if (!b.lat || !b.lon) return;
    L.circleMarker([b.lat, b.lon], {{
        radius: 5, fillColor: '#ffd600', fillOpacity: 0.8, color: '#000', weight: 1
    }}).addTo(busStopLayer).on('click', function() {{
        setInfo(['Bus Stop', b.name || 'Unnamed', 'No-parking zone (100m radius)']);
    }});
}});

document.getElementById('s-parking').textContent = supply.length;
document.getElementById('s-demand').textContent = demandGen.length;
document.getElementById('s-bus').textContent = busStops.length;

var pListEl = document.getElementById('pressure-list');
pressureZones.slice(0, 15).forEach(function(p, i) {{
    pListEl.appendChild(buildListItem(i+1, p.road_name, p.pressure_score, function() {{
        map.setView([p.lat, p.lon], 16);
    }}));
}});

L.control.layers(null, {{
    'Congestion Hotspots': congestionLayer,
    'Parking Supply': parkingSupplyLayer,
    'Demand Generators': parkingDemandLayer,
    'Parking Pressure': parkingPressureLayer,
    'Bus Stops': busStopLayer
}}).addTo(map);

function showTab(tab) {{
    document.getElementById('tab-congestion').style.display = tab === 'congestion' ? 'block' : 'none';
    document.getElementById('tab-parking').style.display = tab === 'parking' ? 'block' : 'none';
    if (tab === 'congestion') {{
        map.addLayer(congestionLayer);
        map.removeLayer(parkingSupplyLayer); map.removeLayer(parkingDemandLayer);
        map.removeLayer(parkingPressureLayer); map.removeLayer(busStopLayer);
    }} else {{
        map.removeLayer(congestionLayer);
        map.addLayer(parkingSupplyLayer); map.addLayer(parkingDemandLayer);
        map.addLayer(parkingPressureLayer); map.addLayer(busStopLayer);
    }}
}}
</script>
</body>
</html>"""

    out_path = OUT_DIR / "traffic_solutions_map.html"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"  Saved: {out_path.name}")
    return out_path


# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Guna Traffic Solutions Analysis")
    parser.add_argument("--congestion", action="store_true", help="Run congestion analysis only")
    parser.add_argument("--parking", action="store_true", help="Run parking analysis only")
    args = parser.parse_args()

    run_all = not args.congestion and not args.parking

    congestion_data = None
    parking_data = None

    if run_all or args.congestion:
        congestion_data = run_congestion_analysis()

    if run_all or args.parking:
        parking_data = run_parking_analysis()

    generate_solutions_map(congestion_data, parking_data)

    print("\n" + "=" * 60)
    print("DONE")
    print("=" * 60)


if __name__ == "__main__":
    main()
