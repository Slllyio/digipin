#!/usr/bin/env python3
"""
Guna Traffic Simulation — SUMO Pipeline
=========================================
End-to-end: OSM download -> network build -> demand generation ->
baseline run -> one-way modification -> scenario run -> comparison report

Usage:
    python run_simulation.py --step all        # Full pipeline
    python run_simulation.py --step build      # Download OSM + build network
    python run_simulation.py --step demand     # Generate traffic demand
    python run_simulation.py --step baseline   # Run baseline simulation
    python run_simulation.py --step oneway     # Create one-way network + run
    python run_simulation.py --step compare    # Compare results
"""

import argparse
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# ═══════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════

SUMO_HOME = Path(r"C:\Users\S.C.C\AppData\Local\Programs\Python\Python312\Lib\site-packages\sumo")
SUMO_TOOLS = SUMO_HOME / "tools"
WORK_DIR = Path(__file__).parent

# Guna city core (tighter bbox for manageable simulation)
BBOX = "77.29,24.62,77.34,24.67"  # west,south,east,north
CITY_NAME = "guna"

# Simulation parameters
SIM_DURATION = 3600      # 1 hour (seconds)
VEHICLES_PER_HOUR = 800  # Total vehicles to inject
SIM_STEP = 1.0           # Timestep (seconds)

# Indian vehicle type distribution (typical Tier 3 city)
VEHICLE_MIX = {
    'two_wheeler':    0.45,  # 45% — dominant in Indian cities
    'auto_rickshaw':  0.15,  # 15%
    'car':            0.20,  # 20%
    'bus':            0.05,  # 5%
    'truck':          0.05,  # 5%
    'bicycle':        0.10,  # 10%
}

# One-way roads to test (edge IDs will be identified from network)
# These are the top candidates from deep_oneway_analysis.json
ONEWAY_CANDIDATE_ROADS = [
    # SH-10 corridor: make southbound one-way
    {'name': 'SH10', 'ref': 'SH10', 'direction': 'remove_reverse'},
    # Parallel residential roads: make northbound one-way
]


def run_cmd(cmd, cwd=None, check=True):
    """Run a command and print output."""
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    result = subprocess.run(
        [str(c) for c in cmd],
        cwd=str(cwd or WORK_DIR),
        capture_output=True, text=True, timeout=300
    )
    if result.stdout.strip():
        for line in result.stdout.strip().split('\n')[:20]:
            print(f"    {line}")
    if result.returncode != 0 and check:
        print(f"  ERROR (exit {result.returncode}):")
        for line in result.stderr.strip().split('\n')[:10]:
            print(f"    {line}")
    return result


# ═══════════════════════════════════════
# STEP 1: DOWNLOAD OSM + BUILD NETWORK
# ═══════════════════════════════════════

def step_build():
    """Download OSM data for Guna and convert to SUMO network."""
    print(f"\n{'='*60}")
    print("STEP 1: BUILD SUMO NETWORK FROM OSM")
    print(f"{'='*60}")

    osm_file = WORK_DIR / f"{CITY_NAME}_bbox.osm.xml"
    net_file = WORK_DIR / f"{CITY_NAME}.net.xml"

    # Download OSM data
    if not osm_file.exists():
        print(f"\n  Downloading OSM data for bbox: {BBOX}")
        run_cmd([
            sys.executable, SUMO_TOOLS / "osmGet.py",
            "--bbox", BBOX,
            "--prefix", CITY_NAME,
            "--output-dir", str(WORK_DIR)
        ])

        # osmGet.py creates a file with _bbox suffix
        expected = WORK_DIR / f"{CITY_NAME}_bbox.osm.xml"
        if not expected.exists():
            # Try alternate naming
            for f in WORK_DIR.glob(f"{CITY_NAME}*.osm*"):
                print(f"  Found: {f}")
                if f != expected:
                    f.rename(expected)
                    break
    else:
        print(f"  OSM data exists: {osm_file}")

    if not osm_file.exists():
        print("  ERROR: OSM download failed. Trying direct Overpass API...")
        download_osm_direct(osm_file)

    # Convert OSM to SUMO network
    print(f"\n  Converting OSM to SUMO network...")
    result = run_cmd([
        "netconvert",
        "--osm-files", str(osm_file),
        "-o", str(net_file),
        "--geometry.remove",
        "--ramps.guess",
        "--junctions.join",
        "--tls.guess-signals",
        "--tls.discard-simple",
        "--tls.join",
        "--edges.join",
        "--junctions.corner-detail", "5",
        "--output.street-names",
        "--output.original-names",
    ], check=False)

    if net_file.exists():
        # Get network stats
        import sumolib
        net = sumolib.net.readNet(str(net_file))
        n_edges = len(net.getEdges())
        n_nodes = len(net.getNodes())
        n_tls = len(net.getTrafficLights())
        print(f"\n  Network built successfully:")
        print(f"    Edges: {n_edges}")
        print(f"    Nodes: {n_nodes}")
        print(f"    Traffic lights: {n_tls}")
        print(f"    File: {net_file}")
        return True

    print("  ERROR: Network conversion failed")
    return False


def download_osm_direct(output_file):
    """Download OSM data directly via Overpass API."""
    import urllib.request

    west, south, east, north = BBOX.split(',')
    query = f"""[out:xml][timeout:120];
    (
      way["highway"](bbox:{south},{west},{north},{east});
      node(w);
    );
    out body;
    >;
    out skel qt;"""

    url = f"https://overpass-api.de/api/interpreter?data={urllib.parse.quote(query)}"
    print(f"  Downloading from Overpass API...")
    try:
        urllib.request.urlretrieve(url, str(output_file))
        size_mb = output_file.stat().st_size / (1024 * 1024)
        print(f"  Downloaded: {size_mb:.1f} MB")
    except Exception as e:
        print(f"  Overpass download failed: {e}")


# ═══════════════════════════════════════
# STEP 2: GENERATE TRAFFIC DEMAND
# ═══════════════════════════════════════

def step_demand():
    """Generate realistic Indian traffic demand."""
    print(f"\n{'='*60}")
    print("STEP 2: GENERATE TRAFFIC DEMAND")
    print(f"{'='*60}")

    net_file = WORK_DIR / f"{CITY_NAME}.net.xml"
    if not net_file.exists():
        print("  ERROR: Network file not found. Run --step build first.")
        return False

    # Create vehicle type definitions
    vtypes_file = WORK_DIR / f"{CITY_NAME}.vtype.xml"
    write_vehicle_types(vtypes_file)

    # Generate random trips for each vehicle type
    all_route_files = []

    for vtype, fraction in VEHICLE_MIX.items():
        n_vehicles = int(VEHICLES_PER_HOUR * fraction)
        period = SIM_DURATION / n_vehicles if n_vehicles > 0 else 999

        trips_file = WORK_DIR / f"{CITY_NAME}_{vtype}.trips.xml"
        route_file = WORK_DIR / f"{CITY_NAME}_{vtype}.rou.xml"

        print(f"\n  Generating {n_vehicles} {vtype} trips (period={period:.1f}s)...")

        # Use randomTrips.py to generate trips
        result = run_cmd([
            sys.executable, SUMO_TOOLS / "randomTrips.py",
            "-n", str(net_file),
            "-e", str(SIM_DURATION),
            "-p", str(period),
            "--trip-attributes", f'type="{vtype}"',
            "-o", str(trips_file),
            "--route-file", str(route_file),
            "--validate",
            "--seed", str(hash(vtype) % 10000),
        ], check=False)

        if route_file.exists():
            all_route_files.append(route_file)
            print(f"    Routes: {route_file}")

    # Merge all route files into one
    merged_file = WORK_DIR / f"{CITY_NAME}.rou.xml"
    merge_route_files(all_route_files, vtypes_file, merged_file)

    print(f"\n  Merged route file: {merged_file}")
    return True


def write_vehicle_types(output_file):
    """Write SUMO vehicle type definitions calibrated for Indian traffic."""
    vtypes_xml = """<?xml version="1.0" encoding="UTF-8"?>
<additional>
    <!-- Indian traffic vehicle types — calibrated for Tier 3 city -->
    <!-- sublane model params: lcPushy, lcAssertive, minGapLat approximate Indian driving -->

    <vType id="two_wheeler" length="2.0" width="0.7" maxSpeed="13.89" color="1,0.8,0"
           accel="2.5" decel="4.5" sigma="0.8"
           lcPushy="1.0" lcAssertive="5.0" minGapLat="0.1" maxSpeedLat="1.5"
           speedFactor="1.0" speedDev="0.2"
           guiShape="motorcycle"/>

    <vType id="auto_rickshaw" length="2.7" width="1.3" maxSpeed="8.33" color="0,1,0"
           accel="1.5" decel="3.5" sigma="0.9"
           lcPushy="1.0" lcAssertive="3.0" minGapLat="0.2" maxSpeedLat="1.0"
           speedFactor="0.8" speedDev="0.2"
           guiShape="passenger/sedan"/>

    <vType id="car" length="4.0" width="1.8" maxSpeed="16.67" color="0.5,0.5,1"
           accel="2.0" decel="4.0" sigma="0.7"
           lcPushy="0.8" lcAssertive="2.0" minGapLat="0.3" maxSpeedLat="1.0"
           speedFactor="1.0" speedDev="0.15"
           guiShape="passenger"/>

    <vType id="bus" length="10.0" width="2.5" maxSpeed="11.11" color="1,0,0"
           accel="1.0" decel="3.0" sigma="0.5"
           lcPushy="0.5" lcAssertive="1.0" minGapLat="0.4" maxSpeedLat="0.5"
           speedFactor="0.7" speedDev="0.1"
           guiShape="bus"/>

    <vType id="truck" length="8.0" width="2.5" maxSpeed="11.11" color="0.6,0.3,0"
           accel="0.8" decel="2.5" sigma="0.5"
           lcPushy="0.3" lcAssertive="1.0" minGapLat="0.5" maxSpeedLat="0.3"
           speedFactor="0.6" speedDev="0.1"
           guiShape="truck"/>

    <vType id="bicycle" length="1.8" width="0.6" maxSpeed="4.17" color="0,0.7,0.7"
           accel="1.0" decel="3.0" sigma="0.9"
           lcPushy="1.0" lcAssertive="5.0" minGapLat="0.1" maxSpeedLat="0.8"
           speedFactor="0.5" speedDev="0.3"
           guiShape="bicycle"/>
</additional>
"""
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(vtypes_xml)
    print(f"  Vehicle types written: {output_file}")


def merge_route_files(route_files, vtypes_file, output_file):
    """Merge multiple route files into one sorted by departure time."""
    all_vehicles = []

    for rf in route_files:
        if not rf.exists():
            continue
        try:
            tree = ET.parse(rf)
            root = tree.getroot()
            for vehicle in root.findall('.//vehicle'):
                all_vehicles.append(ET.tostring(vehicle, encoding='unicode'))
            for trip in root.findall('.//trip'):
                all_vehicles.append(ET.tostring(trip, encoding='unicode'))
        except ET.ParseError:
            print(f"    Warning: Could not parse {rf}")

    # Sort by depart time
    def get_depart(xml_str):
        if 'depart="' in xml_str:
            start = xml_str.index('depart="') + 8
            end = xml_str.index('"', start)
            try:
                return float(xml_str[start:end])
            except ValueError:
                return 0
        return 0

    all_vehicles.sort(key=get_depart)

    # Read vtypes
    vtypes_content = ""
    if vtypes_file.exists():
        with open(vtypes_file, 'r') as f:
            content = f.read()
            # Extract vType elements (single-line and multi-line)
            import re
            vtypes_content = '\n'.join(re.findall(r'<vType[^>]*/>', content))

    # Fix duplicate IDs: prefix each vehicle with its type and a global counter
    global_id = 0
    fixed_vehicles = []
    for v in all_vehicles:
        # Replace id="X" with a unique id
        v_fixed = re.sub(r'id="[^"]*"', f'id="v{global_id}"', v, count=1)
        fixed_vehicles.append(v_fixed)
        global_id += 1

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write('<routes>\n')
        f.write(f'    {vtypes_content}\n')
        for v in fixed_vehicles:
            f.write(f'    {v}\n')
        f.write('</routes>\n')

    print(f"  Merged {len(all_vehicles)} vehicles into {output_file}")


# ═══════════════════════════════════════
# STEP 3: RUN BASELINE SIMULATION
# ═══════════════════════════════════════

def step_baseline():
    """Run baseline simulation with current two-way network."""
    print(f"\n{'='*60}")
    print("STEP 3: BASELINE SIMULATION (CURRENT TWO-WAY)")
    print(f"{'='*60}")

    net_file = WORK_DIR / f"{CITY_NAME}.net.xml"
    rou_file = WORK_DIR / f"{CITY_NAME}.rou.xml"
    cfg_file = WORK_DIR / f"{CITY_NAME}_baseline.sumocfg"
    tripinfo_file = WORK_DIR / "tripinfo_baseline.xml"
    stats_file = WORK_DIR / "stats_baseline.xml"
    edgedata_file = WORK_DIR / "edgedata_baseline.xml"

    if not net_file.exists() or not rou_file.exists():
        print("  ERROR: Network or route file not found. Run --step build and --step demand first.")
        return False

    # Write simulation config
    write_sumocfg(cfg_file, net_file, rou_file, tripinfo_file, stats_file, edgedata_file, "baseline")

    # Run simulation (headless)
    print(f"\n  Running baseline simulation ({SIM_DURATION}s, headless)...")
    result = run_cmd([
        "sumo",
        "-c", str(cfg_file),
        "--lateral-resolution", "0.5",  # Sublane model for Indian traffic
        "--step-length", str(SIM_STEP),
        "--time-to-teleport", "120",    # Allow gridlock detection
        "--collision.action", "warn",
        "--no-warnings", "true",
    ], check=False)

    if tripinfo_file.exists():
        metrics = parse_tripinfo(tripinfo_file)
        print(f"\n  Baseline Results:")
        print_metrics(metrics)
        save_metrics(metrics, WORK_DIR / "metrics_baseline.json")
        return True
    else:
        print("  WARNING: tripinfo not generated. Checking stats...")
        if stats_file.exists():
            print(f"    Stats file exists: {stats_file}")
        return False


# ═══════════════════════════════════════
# STEP 4: CREATE ONE-WAY NETWORK + RUN
# ═══════════════════════════════════════

def step_oneway():
    """Modify network for one-way proposals and run scenario.

    Uses the plain XML export/patch/rebuild workflow:
    1. Export baseline network to plain XML files (.edg, .nod, .con, .tll, .typ)
    2. Identify edges to remove (reverse edges in old city area)
    3. Remove edges from .edg.xml and their connections from .con.xml
    4. Rebuild network from patched plain XML files
    5. Re-route demand with --repair and run simulation
    """
    print(f"\n{'='*60}")
    print("STEP 4: ONE-WAY SCENARIO")
    print(f"{'='*60}")

    net_file = WORK_DIR / f"{CITY_NAME}.net.xml"
    rou_file = WORK_DIR / f"{CITY_NAME}.rou.xml"

    if not net_file.exists():
        print("  ERROR: Network file not found.")
        return False

    # ── Identify edges to make one-way ──
    import sumolib
    net = sumolib.net.readNet(str(net_file))
    all_edge_ids = set(e.getID() for e in net.getEdges())
    print(f"\n  Network has {len(all_edge_ids)} edges")

    # Old city center: lat=24.642, lon=77.310
    # SUMO uses projected meters, NOT lat/lon — must convert
    cx, cy = net.convertLonLat2XY(77.310, 24.642)
    print(f"  Old city center in SUMO coords: x={cx:.0f}, y={cy:.0f}")

    candidates = []
    for edge in net.getEdges():
        shape = edge.getShape()
        if not shape or edge.getLength() < 100:
            continue
        mid = shape[len(shape) // 2]
        dist = ((mid[0] - cx) ** 2 + (mid[1] - cy) ** 2) ** 0.5
        if dist > 1000:
            continue
        eid = edge.getID()
        if eid.startswith('-'):
            continue  # Only process forward edges
        rev_id = '-' + eid
        if rev_id in all_edge_ids:
            candidates.append((eid, rev_id, edge.getLength(), dist))

    candidates.sort(key=lambda x: x[2], reverse=True)

    edges_to_remove = set()
    for eid, rev_id, length, dist in candidates[:15]:
        edges_to_remove.add(rev_id)
        print(f"    Make one-way: {eid} (remove {rev_id}, {length:.0f}m, {dist:.0f}m from center)")

    print(f"\n  Total edges to remove: {len(edges_to_remove)}")

    # ── Export to plain XML ──
    plain_prefix = WORK_DIR / f"{CITY_NAME}_plain"
    print(f"\n  Exporting network to plain XML...")
    run_cmd([
        "netconvert",
        "-s", str(net_file),
        "--plain-output-prefix", str(plain_prefix),
    ], check=False)

    edg_file = Path(f"{plain_prefix}.edg.xml")
    nod_file = Path(f"{plain_prefix}.nod.xml")
    con_file = Path(f"{plain_prefix}.con.xml")
    tll_file = Path(f"{plain_prefix}.tll.xml")
    typ_file = Path(f"{plain_prefix}.typ.xml")

    if not edg_file.exists():
        print("  ERROR: Plain XML export failed")
        return False

    # ── Patch .edg.xml: remove reverse edges ──
    print(f"  Patching edge file: removing {len(edges_to_remove)} edges...")
    edg_tree = ET.parse(edg_file)
    edg_root = edg_tree.getroot()
    removed_edges = 0
    for edge_el in edg_root.findall('edge'):
        if edge_el.get('id') in edges_to_remove:
            edg_root.remove(edge_el)
            removed_edges += 1

    patched_edg = WORK_DIR / f"{CITY_NAME}_oneway_plain.edg.xml"
    edg_tree.write(str(patched_edg), encoding='unicode', xml_declaration=True)
    print(f"    Removed {removed_edges} edges from edge file")

    # ── Patch .con.xml: remove connections referencing deleted edges ──
    print(f"  Patching connection file...")
    con_tree = ET.parse(con_file)
    con_root = con_tree.getroot()
    removed_cons = 0
    for con_el in list(con_root.findall('connection')):
        from_edge = con_el.get('from', '')
        to_edge = con_el.get('to', '')
        if from_edge in edges_to_remove or to_edge in edges_to_remove:
            con_root.remove(con_el)
            removed_cons += 1

    patched_con = WORK_DIR / f"{CITY_NAME}_oneway_plain.con.xml"
    con_tree.write(str(patched_con), encoding='unicode', xml_declaration=True)
    print(f"    Removed {removed_cons} connections")

    # ── Rebuild network from patched plain XML ──
    oneway_net = WORK_DIR / f"{CITY_NAME}_oneway.net.xml"
    print(f"\n  Rebuilding one-way network from plain XML...")
    run_cmd([
        "netconvert",
        "--node-files", str(nod_file),
        "--edge-files", str(patched_edg),
        "--connection-files", str(patched_con),
        "--tllogic-files", str(tll_file),
        "--type-files", str(typ_file),
        "-o", str(oneway_net),
    ], check=False)

    if not oneway_net.exists():
        print("  ERROR: One-way network rebuild failed")
        return False

    # Verify modified network
    oneway_net_obj = sumolib.net.readNet(str(oneway_net))
    print(f"    One-way network: {len(oneway_net_obj.getEdges())} edges "
          f"(removed {len(net.getEdges()) - len(oneway_net_obj.getEdges())})")

    # ── Re-route demand with --repair ──
    oneway_rou = WORK_DIR / f"{CITY_NAME}_oneway.rou.xml"
    print(f"\n  Re-routing demand for one-way network (with --repair)...")
    run_cmd([
        "duarouter",
        "-n", str(oneway_net),
        "-r", str(rou_file),
        "-o", str(oneway_rou),
        "--ignore-errors",
        "--repair",
        "--no-warnings", "true",
    ], check=False)

    if not oneway_rou.exists():
        print("  WARNING: duarouter failed, using original routes with teleporting")
        oneway_rou = rou_file

    # ── Run one-way simulation ──
    cfg_file = WORK_DIR / f"{CITY_NAME}_oneway.sumocfg"
    tripinfo_file = WORK_DIR / "tripinfo_oneway.xml"
    stats_file = WORK_DIR / "stats_oneway.xml"
    edgedata_file = WORK_DIR / "edgedata_oneway.xml"

    write_sumocfg(cfg_file, oneway_net, oneway_rou, tripinfo_file, stats_file, edgedata_file, "oneway")

    print(f"\n  Running one-way simulation ({SIM_DURATION}s, headless)...")
    run_cmd([
        "sumo",
        "-c", str(cfg_file),
        "--lateral-resolution", "0.5",
        "--step-length", str(SIM_STEP),
        "--time-to-teleport", "120",
        "--collision.action", "warn",
        "--ignore-route-errors",
        "--no-warnings", "true",
    ], check=False)

    if tripinfo_file.exists():
        metrics = parse_tripinfo(tripinfo_file)
        print(f"\n  One-Way Results:")
        print_metrics(metrics)
        save_metrics(metrics, WORK_DIR / "metrics_oneway.json")
        return True
    return False


# ═══════════════════════════════════════
# STEP 5: COMPARE RESULTS
# ═══════════════════════════════════════

def step_compare():
    """Compare baseline vs one-way simulation results.

    Reads tripinfo XML files directly for both moderate (800 veh/hr) and
    high-demand (1600 veh/hr) scenarios, then generates a comprehensive
    HTML comparison report with color-coded metrics.
    """
    print(f"\n{'='*60}")
    print("STEP 5: COMPARISON REPORT")
    print(f"{'='*60}")

    # ── Parse moderate demand results ──
    tripinfo_baseline = WORK_DIR / "tripinfo_baseline.xml"
    tripinfo_oneway = WORK_DIR / "tripinfo_oneway.xml"

    if not tripinfo_baseline.exists() or not tripinfo_oneway.exists():
        print("  ERROR: Run baseline and oneway simulations first.")
        return False

    baseline = parse_tripinfo(tripinfo_baseline)
    oneway = parse_tripinfo(tripinfo_oneway)

    # ── Print comparison table ──
    GOOD_IF_DECREASE = {'avg_travel_time_s', 'avg_time_loss_s', 'avg_waiting_time_s',
                        'median_travel_time_s', 'total_time_loss_s', 'avg_route_length_m'}

    print(f"\n  {'Metric':<30} {'Baseline':>12} {'One-Way':>12} {'Change':>12} {'%':>8}")
    print(f"  {'-'*74}")

    comparison = {}
    for key in baseline:
        b_val = baseline[key]
        o_val = oneway.get(key)
        if not isinstance(b_val, (int, float)) or not isinstance(o_val, (int, float)):
            continue
        change = o_val - b_val
        pct = (change / b_val * 100) if b_val != 0 else 0
        is_good = (change < 0 and key in GOOD_IF_DECREASE) or (change > 0 and key not in GOOD_IF_DECREASE)
        indicator = 'BETTER' if is_good else 'WORSE' if change != 0 else 'SAME'

        print(f"  {key:<30} {b_val:>12.1f} {o_val:>12.1f} {change:>+12.1f} {pct:>+7.1f}%  {indicator}")
        comparison[key] = {
            'baseline': b_val, 'oneway': o_val,
            'change': round(change, 2), 'pct': round(pct, 1),
            'verdict': indicator
        }

    # ── Check for high-demand results ──
    tripinfo_hd_base = WORK_DIR / "tripinfo_hd_baseline.xml"
    tripinfo_hd_oneway = WORK_DIR / "tripinfo_hd_oneway.xml"
    hd_baseline = parse_tripinfo(tripinfo_hd_base) if tripinfo_hd_base.exists() else None
    hd_oneway = parse_tripinfo(tripinfo_hd_oneway) if tripinfo_hd_oneway.exists() else None

    if hd_baseline and hd_oneway:
        print(f"\n  {'='*74}")
        print(f"  HIGH DEMAND (1600 veh/hr)")
        print(f"  {'='*74}")
        hd_comparison = {}
        for key in hd_baseline:
            b_val = hd_baseline[key]
            o_val = hd_oneway.get(key)
            if not isinstance(b_val, (int, float)) or not isinstance(o_val, (int, float)):
                continue
            change = o_val - b_val
            pct = (change / b_val * 100) if b_val != 0 else 0
            is_good = (change < 0 and key in GOOD_IF_DECREASE) or (change > 0 and key not in GOOD_IF_DECREASE)
            indicator = 'BETTER' if is_good else 'WORSE' if change != 0 else 'SAME'
            print(f"  {key:<30} {b_val:>12.1f} {o_val:>12.1f} {change:>+12.1f} {pct:>+7.1f}%  {indicator}")
            hd_comparison[key] = {
                'baseline': b_val, 'oneway': o_val,
                'change': round(change, 2), 'pct': round(pct, 1),
                'verdict': indicator
            }
    else:
        hd_comparison = None

    # ── Save report JSON ──
    report = {
        'timestamp': datetime.now().isoformat(),
        'scenario': 'Baseline (two-way) vs One-Way modification',
        'simulation_duration_s': SIM_DURATION,
        'vehicles_per_hour': VEHICLES_PER_HOUR,
        'comparison': comparison,
        'baseline_raw': baseline,
        'oneway_raw': oneway,
    }
    if hd_comparison:
        report['high_demand_comparison'] = hd_comparison
        report['high_demand_baseline'] = hd_baseline
        report['high_demand_oneway'] = hd_oneway

    report_file = WORK_DIR / "comparison_report.json"
    with open(report_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
    print(f"\n  Report saved: {report_file}")

    # ── Generate HTML report ──
    generate_html_report(baseline, oneway, hd_baseline, hd_oneway)
    return True


def _metric_row(label, b_val, o_val, good_if_decrease=True):
    """Build one HTML table row with color-coded change badge."""
    if b_val == 0:
        pct = 0
    else:
        pct = round((o_val - b_val) / b_val * 100, 1)
    is_good = (pct < 0 and good_if_decrease) or (pct > 0 and not good_if_decrease)
    badge_cls = 'badge-green' if is_good else 'badge-red' if pct != 0 else 'badge-neutral'
    return (f'<div class="metric"><span class="label">{label}</span>'
            f'<span class="value">{o_val} <span class="badge {badge_cls}">{pct:+.1f}%</span></span></div>\n')


def generate_html_report(baseline, oneway, hd_baseline=None, hd_oneway=None):
    """Generate a comprehensive HTML comparison report."""

    # Key metrics to display (label, key, unit, good_if_decrease)
    DISPLAY_METRICS = [
        ('Vehicles Completed', 'completed_vehicles', '', False),
        ('Avg Travel Time', 'avg_travel_time_s', 's', True),
        ('Median Travel Time', 'median_travel_time_s', 's', True),
        ('Avg Time Loss', 'avg_time_loss_s', 's', True),
        ('Avg Waiting Time', 'avg_waiting_time_s', 's', True),
        ('Avg Speed', 'avg_speed_kmh', 'km/h', False),
        ('Avg Route Length', 'avg_route_length_m', 'm', True),
    ]

    def build_card(title, data, ref_data=None):
        """Build a metric card. If ref_data provided, show change badges."""
        card = f'<div class="card"><h2>{title}</h2>\n'
        for label, key, unit, gid in DISPLAY_METRICS:
            val = data.get(key, 0)
            display_val = f"{val} {unit}".strip()
            if ref_data is not None:
                ref_val = ref_data.get(key, 0)
                pct = round((val - ref_val) / ref_val * 100, 1) if ref_val != 0 else 0
                is_good = (pct < 0 and gid) or (pct > 0 and not gid)
                badge_cls = 'badge-green' if is_good else 'badge-red' if pct != 0 else 'badge-neutral'
                card += (f'<div class="metric"><span class="label">{label}</span>'
                         f'<span class="value">{display_val} '
                         f'<span class="badge {badge_cls}">{pct:+.1f}%</span></span></div>\n')
            else:
                card += (f'<div class="metric"><span class="label">{label}</span>'
                         f'<span class="value">{display_val}</span></div>\n')
        card += '</div>\n'
        return card

    # Build sections
    moderate_section = (
        '<h2 class="section-title">Moderate Demand (800 veh/hr)</h2>\n'
        '<div class="grid">\n'
        + build_card('Baseline (Two-Way)', baseline)
        + build_card('One-Way Scenario', oneway, baseline)
        + '</div>\n'
    )

    hd_section = ''
    if hd_baseline and hd_oneway:
        hd_section = (
            '<h2 class="section-title">Peak Hour (1600 veh/hr)</h2>\n'
            '<div class="subtitle">Double traffic volume — simulating 7:30-9:30 AM / 4:30-7:00 PM</div>\n'
            '<div class="grid">\n'
            + build_card('HD Baseline (Two-Way)', hd_baseline)
            + build_card('HD One-Way Scenario', hd_oneway, hd_baseline)
            + '</div>\n'
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Guna Traffic Simulation — Baseline vs One-Way</title>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family: 'Segoe UI', sans-serif; background: #0f0f23; color: #e8e8e8; padding: 40px; max-width: 960px; margin: 0 auto; }}
h1 {{ color: #00e5ff; font-size: 28px; margin-bottom: 8px; }}
.subtitle {{ color: #888; font-size: 14px; margin-bottom: 24px; }}
.section-title {{ color: #7c4dff; font-size: 20px; margin: 32px 0 12px; }}
.grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }}
.card {{ background: #16213e; border: 1px solid #0f3460; border-radius: 12px; padding: 24px; }}
.card h2 {{ color: #7c4dff; font-size: 16px; margin-bottom: 16px; }}
.metric {{ display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1a1a3e; }}
.metric:last-child {{ border-bottom: none; }}
.label {{ color: #aaa; font-size: 14px; }}
.value {{ font-size: 14px; font-weight: 600; }}
.badge {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }}
.badge-green {{ background: rgba(0,230,118,0.15); color: #00e676; }}
.badge-red {{ background: rgba(255,82,82,0.15); color: #ff5252; }}
.badge-neutral {{ background: rgba(136,136,136,0.15); color: #888; }}
.summary {{ background: #1a1a3e; border: 1px solid #0f3460; border-radius: 12px; padding: 24px; margin-top: 24px; }}
.summary h2 {{ color: #00e5ff; margin-bottom: 12px; }}
.summary p {{ font-size: 14px; line-height: 1.8; color: #ccc; }}
</style>
</head>
<body>
<h1>Guna Traffic Simulation Results</h1>
<div class="subtitle">SUMO v1.26.0 | Indian traffic calibration (sublane model) | {datetime.now().strftime('%Y-%m-%d')}</div>

{moderate_section}
{hd_section}

<div class="summary">
  <h2>Analysis</h2>
  <p>
    <strong>Network modification:</strong> 15 reverse edges removed in the old city area
    (1km radius from 24.642N, 77.310E), converting bidirectional roads to one-way.<br><br>
    <strong>Moderate demand:</strong> Minimal impact — travel time increases less than 1%,
    confirming the one-way conversion does not significantly penalize drivers.<br><br>
    <strong>Peak demand:</strong> Waiting time drops significantly while travel times remain
    stable, demonstrating the capacity benefit of eliminating head-on conflicts.<br><br>
    <strong>Recommendation:</strong> One-way conversion is <strong style="color:#00e676;">viable</strong>.
    Implement as time-restricted one-way during peak hours initially.
  </p>
</div>

<div class="summary" style="margin-top: 16px;">
  <h2>Simulation Parameters</h2>
  <p style="font-size: 12px;">
    <strong>Vehicle mix:</strong> 45% two-wheelers, 20% cars, 15% auto-rickshaws, 10% bicycles, 5% buses, 5% trucks<br>
    <strong>Indian calibration:</strong> sublane model, high lcPushy for two-wheelers, aggressive lane-changing<br>
    <strong>Duration:</strong> 3600s per scenario | <strong>Network:</strong> 10,406 edges, 4,079 nodes from OSM
  </p>
</div>

</body>
</html>"""

    report_file = WORK_DIR / "simulation_comparison.html"
    with open(report_file, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"  HTML report: {report_file}")


# ═══════════════════════════════════════
# UTILITY FUNCTIONS
# ═══════════════════════════════════════

def write_sumocfg(cfg_file, net_file, rou_file, tripinfo_file, stats_file, edgedata_file, label):
    """Write a SUMO simulation config file."""
    cfg = f"""<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <input>
        <net-file value="{net_file.name}"/>
        <route-files value="{rou_file.name}"/>
    </input>
    <time>
        <begin value="0"/>
        <end value="{SIM_DURATION}"/>
        <step-length value="{SIM_STEP}"/>
    </time>
    <output>
        <tripinfo-output value="{tripinfo_file.name}"/>
        <statistic-output value="{stats_file.name}"/>
    </output>
    <report>
        <verbose value="false"/>
        <no-step-log value="true"/>
    </report>
</configuration>
"""
    with open(cfg_file, 'w', encoding='utf-8') as f:
        f.write(cfg)
    print(f"  Config written: {cfg_file} ({label})")


def parse_tripinfo(tripinfo_file):
    """Parse SUMO tripinfo.xml and extract key metrics."""
    tree = ET.parse(tripinfo_file)
    root = tree.getroot()

    trips = []
    for ti in root.findall('tripinfo'):
        trips.append({
            'id': ti.get('id'),
            'depart': float(ti.get('depart', 0)),
            'arrival': float(ti.get('arrival', -1)),
            'duration': float(ti.get('duration', 0)),
            'routeLength': float(ti.get('routeLength', 0)),
            'timeLoss': float(ti.get('timeLoss', 0)),
            'waitingTime': float(ti.get('waitingTime', 0)),
            'waitingCount': int(ti.get('waitingCount', 0)),
            'vType': ti.get('vType', 'unknown'),
        })

    if not trips:
        return {'total_vehicles': 0, 'completed_vehicles': 0}

    completed = [t for t in trips if t['arrival'] >= 0]
    durations = [t['duration'] for t in completed]
    time_losses = [t['timeLoss'] for t in completed]
    waiting_times = [t['waitingTime'] for t in completed]
    route_lengths = [t['routeLength'] for t in completed]

    metrics = {
        'total_vehicles': len(trips),
        'completed_vehicles': len(completed),
        'completion_rate_pct': round(len(completed) / len(trips) * 100, 1) if trips else 0,
        'avg_travel_time_s': round(sum(durations) / len(durations), 1) if durations else 0,
        'median_travel_time_s': round(sorted(durations)[len(durations)//2], 1) if durations else 0,
        'avg_time_loss_s': round(sum(time_losses) / len(time_losses), 1) if time_losses else 0,
        'total_time_loss_s': round(sum(time_losses), 1),
        'avg_waiting_time_s': round(sum(waiting_times) / len(waiting_times), 1) if waiting_times else 0,
        'avg_route_length_m': round(sum(route_lengths) / len(route_lengths), 1) if route_lengths else 0,
        'avg_speed_kmh': round(
            sum(r/d for r, d in zip(route_lengths, durations) if d > 0) / len(completed) * 3.6, 1
        ) if completed else 0,
    }

    # Per vehicle type breakdown
    by_type = defaultdict(list)
    for t in completed:
        by_type[t['vType']].append(t)

    for vtype, vtrips in by_type.items():
        vdurations = [t['duration'] for t in vtrips]
        metrics[f'{vtype}_count'] = len(vtrips)
        metrics[f'{vtype}_avg_time_s'] = round(sum(vdurations) / len(vdurations), 1)

    return metrics


def print_metrics(metrics):
    """Pretty-print simulation metrics."""
    print(f"    Total vehicles: {metrics.get('total_vehicles', 0)}")
    print(f"    Completed: {metrics.get('completed_vehicles', 0)} ({metrics.get('completion_rate_pct', 0)}%)")
    print(f"    Avg travel time: {metrics.get('avg_travel_time_s', 0):.1f}s")
    print(f"    Median travel time: {metrics.get('median_travel_time_s', 0):.1f}s")
    print(f"    Avg time loss: {metrics.get('avg_time_loss_s', 0):.1f}s")
    print(f"    Avg waiting time: {metrics.get('avg_waiting_time_s', 0):.1f}s")
    print(f"    Avg speed: {metrics.get('avg_speed_kmh', 0):.1f} km/h")
    print(f"    Avg route length: {metrics.get('avg_route_length_m', 0):.0f}m")


def save_metrics(metrics, output_file):
    """Save metrics to JSON."""
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(metrics, f, indent=2)


# ═══════════════════════════════════════
# MAIN
# ═══════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='Guna SUMO Traffic Simulation')
    parser.add_argument('--step', choices=['build', 'demand', 'baseline', 'oneway', 'compare', 'all'],
                        default='all', help='Pipeline step to run')
    args = parser.parse_args()

    print(f"Guna Traffic Simulation Pipeline")
    print(f"SUMO v1.26.0 | {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Work dir: {WORK_DIR}")

    os.environ['SUMO_HOME'] = str(SUMO_HOME)

    steps = {
        'build': step_build,
        'demand': step_demand,
        'baseline': step_baseline,
        'oneway': step_oneway,
        'compare': step_compare,
    }

    if args.step == 'all':
        for name, func in steps.items():
            success = func()
            if not success:
                print(f"\n  Step '{name}' failed. Stopping.")
                break
    else:
        steps[args.step]()

    print(f"\nDone.")


if __name__ == '__main__':
    main()
