#!/usr/bin/env python3
"""
Guna Traffic Data Collector
===========================
Collects travel time data from Google Routes API and Mappls API
for key corridors in Guna at different times of day.

Also analyzes OSM road network for bottleneck detection.

Usage:
    python collect_traffic_data.py --mode osm       # Analyze OSM roads (free, no API key)
    python collect_traffic_data.py --mode google     # Collect Google Routes data (needs API key)
    python collect_traffic_data.py --mode mappls     # Collect Mappls data (needs API key)
    python collect_traffic_data.py --mode all        # Run everything

Environment Variables:
    GOOGLE_MAPS_API_KEY  — Google Cloud API key with Routes API enabled
    MAPPLS_API_KEY       — Mappls (MapMyIndia) API key
"""

import json
import argparse
import math
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Guna city bounds and key locations
GUNA_CENTER = (24.6354, 77.3126)
GUNA_CITY_BBOX = {
    'south': 24.58, 'north': 24.70,
    'west': 77.25, 'east': 77.38
}

# Key locations in Guna (approximate coordinates from OSM data)
LOCATIONS = {
    'city_center': (24.648, 77.318),        # SH-10/SH-54 junction
    'railway_station': (24.633, 77.312),     # Guna Railway Station
    'bus_stand': (24.640, 77.315),           # Bus Stand area
    'nh46_north_entry': (24.685, 77.340),    # NH-46 entering from north
    'nh46_south_exit': (24.600, 77.295),     # NH-46 exiting south
    'bypass_north': (24.670, 77.345),        # Guna Bypass north end
    'bypass_south': (24.610, 77.290),        # Guna Bypass south end
    'sh10_east': (24.650, 77.360),           # SH-10 eastern approach
    'sh54_west': (24.645, 77.280),           # SH-54 western approach
}

# Key corridors to monitor
CORRIDORS = [
    {
        'name': 'NH-46 Through City (N→S)',
        'origin': LOCATIONS['nh46_north_entry'],
        'destination': LOCATIONS['nh46_south_exit'],
        'description': 'NH-46 north entry through city center to south exit'
    },
    {
        'name': 'NH-46 Through City (S→N)',
        'origin': LOCATIONS['nh46_south_exit'],
        'destination': LOCATIONS['nh46_north_entry'],
        'description': 'NH-46 south to north (reverse direction)'
    },
    {
        'name': 'Guna Bypass (N→S)',
        'origin': LOCATIONS['bypass_north'],
        'destination': LOCATIONS['bypass_south'],
        'description': 'Bypass route for comparison with through-city'
    },
    {
        'name': 'Station → Bus Stand',
        'origin': LOCATIONS['railway_station'],
        'destination': LOCATIONS['bus_stand'],
        'description': 'Railway station to bus stand corridor'
    },
    {
        'name': 'Bus Stand → Station',
        'origin': LOCATIONS['bus_stand'],
        'destination': LOCATIONS['railway_station'],
        'description': 'Reverse: bus stand to railway station'
    },
    {
        'name': 'SH-10 → SH-54 Junction',
        'origin': LOCATIONS['sh10_east'],
        'destination': LOCATIONS['city_center'],
        'description': 'SH-10 eastern approach to main junction'
    },
    {
        'name': 'SH-54 → City Center',
        'origin': LOCATIONS['sh54_west'],
        'destination': LOCATIONS['city_center'],
        'description': 'SH-54 western approach to main junction'
    },
]

# Time slots to sample (hours in 24h format)
TIME_SLOTS = [6, 8, 10, 12, 14, 16, 18, 20, 22]


# ═══════════════════════════════════════════
# OSM ROAD NETWORK ANALYSIS (FREE — NO API KEY)
# ═══════════════════════════════════════════

def analyze_osm_roads():
    """Analyze the downloaded OSM roads GeoJSON for traffic insights."""
    roads_file = Path(__file__).parent.parent / 'data' / 'vectors' / 'osm_roads_guna.geojson'

    if not roads_file.exists():
        print(f"ERROR: Roads file not found: {roads_file}")
        print("Run the download_vectors.py pipeline first.")
        return None

    print(f"\n{'='*60}")
    print("OSM ROAD NETWORK ANALYSIS — GUNA")
    print(f"{'='*60}\n")

    with open(roads_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    features = data.get('features', [])
    print(f"Total road segments: {len(features)}")

    # Classification breakdown
    classification = defaultdict(lambda: {'count': 0, 'length_km': 0.0, 'names': set(), 'one_way': 0})

    for feat in features:
        props = feat.get('properties', {})
        highway = props.get('highway', 'unknown')
        name = props.get('name', '')
        ref = props.get('ref', '')
        oneway = props.get('oneway', 'no')
        lanes = props.get('lanes', '')
        surface = props.get('surface', '')

        # Calculate segment length
        geom = feat.get('geometry', {})
        length_km = _calculate_geojson_length(geom)

        classification[highway]['count'] += 1
        classification[highway]['length_km'] += length_km
        if oneway in ('yes', '1', 'true'):
            classification[highway]['one_way'] += 1
        if name:
            classification[highway]['names'].add(name)
        if ref:
            classification[highway]['names'].add(f"[{ref}]")

    # Print classification table
    print(f"\n{'Highway Type':<18} {'Segments':>8} {'Length (km)':>12} {'One-Way':>8} {'Named Roads'}")
    print('-' * 90)

    sorted_types = sorted(classification.items(), key=lambda x: x[1]['length_km'], reverse=True)
    total_length = 0
    total_segments = 0
    total_oneway = 0

    for htype, info in sorted_types:
        total_length += info['length_km']
        total_segments += info['count']
        total_oneway += info['one_way']
        names_str = ', '.join(sorted(info['names'])[:5])
        if len(info['names']) > 5:
            names_str += f' (+{len(info["names"])-5} more)'
        print(f"{htype:<18} {info['count']:>8} {info['length_km']:>12.2f} {info['one_way']:>8} {names_str}")

    print('-' * 90)
    print(f"{'TOTAL':<18} {total_segments:>8} {total_length:>12.2f} {total_oneway:>8}")

    # Identify city-core roads (within GUNA_CITY_BBOX)
    city_roads = []
    for feat in features:
        geom = feat.get('geometry', {})
        coords = _get_all_coords(geom)
        if any(_in_bbox(c, GUNA_CITY_BBOX) for c in coords):
            city_roads.append(feat)

    print(f"\n\nCity-core road segments (within municipal bounds): {len(city_roads)}")

    # Intersection density analysis
    node_connections = defaultdict(int)
    for feat in city_roads:
        geom = feat.get('geometry', {})
        coords = _get_all_coords(geom)
        if coords:
            # Count start and end nodes (approximate intersections)
            start = _round_coord(coords[0])
            end = _round_coord(coords[-1])
            node_connections[start] += 1
            node_connections[end] += 1

    # Find high-connectivity nodes (likely intersections)
    intersections = {k: v for k, v in node_connections.items() if v >= 4}
    print(f"High-connectivity intersections (4+ roads): {len(intersections)}")
    print(f"\nTop 10 busiest intersections:")
    for coord, degree in sorted(intersections.items(), key=lambda x: x[1], reverse=True)[:10]:
        print(f"  [{coord[0]:.4f}, {coord[1]:.4f}] — {degree} connecting roads")

    # One-way analysis for city core
    city_oneway = [f for f in city_roads if f.get('properties', {}).get('oneway') in ('yes', '1', 'true')]
    city_non_oneway_arterial = [
        f for f in city_roads
        if f.get('properties', {}).get('highway') in ('primary', 'secondary', 'tertiary')
        and f.get('properties', {}).get('oneway') not in ('yes', '1', 'true')
    ]

    print(f"\n\nONE-WAY ANALYSIS (City Core):")
    print(f"  One-way segments: {len(city_oneway)}")
    print(f"  Two-way arterial segments (primary/secondary/tertiary): {len(city_non_oneway_arterial)}")
    print(f"  => {len(city_non_oneway_arterial)} arterial segments could be candidates for one-way conversion")

    # Output candidate roads for one-way conversion
    candidate_roads = defaultdict(lambda: {'segments': 0, 'length_km': 0.0})
    for feat in city_non_oneway_arterial:
        props = feat.get('properties', {})
        name = props.get('name') or props.get('ref') or 'Unnamed'
        highway = props.get('highway', '')
        key = f"{name} ({highway})"
        candidate_roads[key]['segments'] += 1
        candidate_roads[key]['length_km'] += _calculate_geojson_length(feat.get('geometry', {}))

    if candidate_roads:
        print(f"\n  Candidate arterial roads for one-way conversion:")
        for road, info in sorted(candidate_roads.items(), key=lambda x: x[1]['length_km'], reverse=True)[:15]:
            print(f"    {road}: {info['segments']} segments, {info['length_km']:.2f} km")

    # Save analysis results
    results = {
        'timestamp': datetime.now().isoformat(),
        'total_segments': total_segments,
        'total_length_km': round(total_length, 2),
        'city_core_segments': len(city_roads),
        'one_way_segments': total_oneway,
        'city_one_way_segments': len(city_oneway),
        'high_connectivity_intersections': len(intersections),
        'top_intersections': [
            {'lat': coord[0], 'lng': coord[1], 'degree': degree}
            for coord, degree in sorted(intersections.items(), key=lambda x: x[1], reverse=True)[:20]
        ],
        'classification': {
            htype: {'count': info['count'], 'length_km': round(info['length_km'], 2), 'one_way': info['one_way']}
            for htype, info in sorted_types
        },
        'candidate_oneway_roads': [
            {'name': road, 'segments': info['segments'], 'length_km': round(info['length_km'], 2)}
            for road, info in sorted(candidate_roads.items(), key=lambda x: x[1]['length_km'], reverse=True)[:20]
        ]
    }

    output_file = Path(__file__).parent / 'osm_analysis.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2)
    print(f"\n  Analysis saved to: {output_file}")

    return results


# ═══════════════════════════════════════════
# GOOGLE ROUTES API DATA COLLECTION
# ═══════════════════════════════════════════

def collect_google_routes_data():
    """Collect travel time data from Google Routes API."""
    api_key = os.environ.get('GOOGLE_MAPS_API_KEY')
    if not api_key:
        print("\nERROR: Set GOOGLE_MAPS_API_KEY environment variable")
        print("  Get a key at: https://console.cloud.google.com/apis/credentials")
        print("  Enable: Routes API (or Directions API)")
        return None

    try:
        import requests
    except ImportError:
        print("ERROR: pip install requests")
        return None

    print(f"\n{'='*60}")
    print("GOOGLE ROUTES API — TRAVEL TIME COLLECTION")
    print(f"{'='*60}\n")

    results = []

    for corridor in CORRIDORS:
        print(f"\n  Corridor: {corridor['name']}")
        origin = corridor['origin']
        dest = corridor['destination']

        # Query current traffic-aware travel time
        url = 'https://routes.googleapis.com/directions/v2:computeRoutes'
        headers = {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': api_key,
            'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.staticDuration'
        }
        body = {
            'origin': {
                'location': {
                    'latLng': {'latitude': origin[0], 'longitude': origin[1]}
                }
            },
            'destination': {
                'location': {
                    'latLng': {'latitude': dest[0], 'longitude': dest[1]}
                }
            },
            'travelMode': 'DRIVE',
            'routingPreference': 'TRAFFIC_AWARE'
        }

        try:
            resp = requests.post(url, headers=headers, json=body, timeout=30)
            resp.raise_for_status()
            data = resp.json()

            if 'routes' in data and data['routes']:
                route = data['routes'][0]
                duration_s = int(route.get('duration', '0s').replace('s', ''))
                static_s = int(route.get('staticDuration', '0s').replace('s', ''))
                distance_m = route.get('distanceMeters', 0)

                congestion_ratio = duration_s / static_s if static_s > 0 else 1.0

                result = {
                    'corridor': corridor['name'],
                    'timestamp': datetime.now().isoformat(),
                    'distance_km': round(distance_m / 1000, 2),
                    'duration_traffic_min': round(duration_s / 60, 1),
                    'duration_static_min': round(static_s / 60, 1),
                    'congestion_ratio': round(congestion_ratio, 2),
                    'congestion_level': (
                        'FREE_FLOW' if congestion_ratio < 1.1 else
                        'LIGHT' if congestion_ratio < 1.3 else
                        'MODERATE' if congestion_ratio < 1.6 else
                        'HEAVY' if congestion_ratio < 2.0 else
                        'SEVERE'
                    )
                }
                results.append(result)

                print(f"    Distance: {result['distance_km']} km")
                print(f"    Travel time (traffic): {result['duration_traffic_min']} min")
                print(f"    Travel time (free-flow): {result['duration_static_min']} min")
                print(f"    Congestion ratio: {result['congestion_ratio']}x ({result['congestion_level']})")
            else:
                print(f"    No route found")

        except Exception as e:
            print(f"    ERROR: {e}")

    # Save results
    output_file = Path(__file__).parent / 'google_routes_data.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump({
            'collection_time': datetime.now().isoformat(),
            'corridors': results
        }, f, indent=2)
    print(f"\n  Results saved to: {output_file}")

    return results


# ═══════════════════════════════════════════
# MAPPLS (MAPMYINDIA) DATA COLLECTION
# ═══════════════════════════════════════════

def collect_mappls_data():
    """Collect traffic data from Mappls (MapMyIndia) API."""
    api_key = os.environ.get('MAPPLS_API_KEY')
    if not api_key:
        print("\nERROR: Set MAPPLS_API_KEY environment variable")
        print("  Get a key at: https://about.mappls.com/api/")
        return None

    try:
        import requests
    except ImportError:
        print("ERROR: pip install requests")
        return None

    print(f"\n{'='*60}")
    print("MAPPLS (MapMyIndia) — TRAFFIC DATA COLLECTION")
    print(f"{'='*60}\n")

    # Mappls uses OAuth2 token-based auth
    token_url = 'https://outpost.mappls.com/api/security/oauth/token'
    token_data = {
        'grant_type': 'client_credentials',
        'client_id': api_key,
        'client_secret': os.environ.get('MAPPLS_CLIENT_SECRET', ''),
    }

    try:
        token_resp = requests.post(token_url, data=token_data, timeout=30)
        token_resp.raise_for_status()
        access_token = token_resp.json().get('access_token')

        if not access_token:
            print("ERROR: Could not obtain Mappls access token")
            return None

        print(f"  Mappls auth successful")

        # Route API for travel times
        results = []
        for corridor in CORRIDORS:
            origin = corridor['origin']
            dest = corridor['destination']

            route_url = f"https://apis.mappls.com/advancedmaps/v1/{access_token}/route_adv/driving/{origin[1]},{origin[0]};{dest[1]},{dest[0]}"
            params = {'geometries': 'polyline', 'overview': 'full', 'alternatives': 'false'}

            resp = requests.get(route_url, params=params, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                if 'routes' in data and data['routes']:
                    route = data['routes'][0]
                    result = {
                        'corridor': corridor['name'],
                        'timestamp': datetime.now().isoformat(),
                        'distance_km': round(route.get('distance', 0) / 1000, 2),
                        'duration_min': round(route.get('duration', 0) / 60, 1),
                    }
                    results.append(result)
                    print(f"  {corridor['name']}: {result['distance_km']} km, {result['duration_min']} min")

    except Exception as e:
        print(f"  ERROR: {e}")
        return None

    output_file = Path(__file__).parent / 'mappls_data.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump({
            'collection_time': datetime.now().isoformat(),
            'corridors': results
        }, f, indent=2)
    print(f"\n  Results saved to: {output_file}")

    return results


# ═══════════════════════════════════════════
# UTILITY FUNCTIONS
# ═══════════════════════════════════════════

def _calculate_geojson_length(geometry):
    """Calculate length of a GeoJSON geometry in kilometers using Haversine."""
    coords = _get_ordered_coords(geometry)
    if len(coords) < 2:
        return 0.0

    total = 0.0
    for i in range(len(coords) - 1):
        total += _haversine(coords[i][1], coords[i][0], coords[i+1][1], coords[i+1][0])
    return total


def _get_ordered_coords(geometry):
    """Get ordered coordinate list from a GeoJSON geometry."""
    gtype = geometry.get('type', '')
    coords = geometry.get('coordinates', [])

    if gtype == 'LineString':
        return coords
    elif gtype == 'MultiLineString':
        # Flatten multi-line into single list
        result = []
        for line in coords:
            result.extend(line)
        return result
    elif gtype == 'Point':
        return [coords]
    return []


def _get_all_coords(geometry):
    """Get all coordinates from a GeoJSON geometry as (lat, lng) tuples."""
    coords = _get_ordered_coords(geometry)
    return [(c[1], c[0]) for c in coords]  # GeoJSON is [lng, lat]


def _in_bbox(coord, bbox):
    """Check if a (lat, lng) coordinate is within a bounding box."""
    return (bbox['south'] <= coord[0] <= bbox['north'] and
            bbox['west'] <= coord[1] <= bbox['east'])


def _round_coord(coord, precision=4):
    """Round coordinate to given decimal precision for node matching."""
    return (round(coord[0], precision), round(coord[1], precision))


def _haversine(lat1, lon1, lat2, lon2):
    """Calculate Haversine distance in km between two points."""
    R = 6371.0  # Earth radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ═══════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='Guna Traffic Data Collector')
    parser.add_argument('--mode', choices=['osm', 'google', 'mappls', 'all'],
                        default='osm', help='Data collection mode')
    args = parser.parse_args()

    print(f"Guna Traffic Data Collector — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Mode: {args.mode}")

    if args.mode in ('osm', 'all'):
        analyze_osm_roads()

    if args.mode in ('google', 'all'):
        collect_google_routes_data()

    if args.mode in ('mappls', 'all'):
        collect_mappls_data()

    print(f"\nDone.")


if __name__ == '__main__':
    main()
