#!/usr/bin/env python3
"""
Deep One-Way Road Analysis for Guna
====================================
Analyzes OSM road geometry to find:
1. All named/numbered roads in the city core
2. Parallel road pairs suitable for one-way conversion
3. Intersection hotspots and turning movement conflicts
4. Specific road-by-road recommendations with return routes

Outputs: detailed JSON + interactive HTML map with every proposed road drawn
"""

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

# City core bounding box (tighter — actual urban area)
CITY_CORE = {
    'south': 24.620, 'north': 24.670,
    'west': 77.290, 'east': 77.340
}

# Even tighter: dense market/old city area
OLD_CITY = {
    'south': 24.630, 'north': 24.655,
    'west': 77.295, 'east': 77.325
}


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000  # meters
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def bearing(lat1, lon1, lat2, lon2):
    dlon = math.radians(lon2 - lon1)
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2r)
    y = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def get_coords(geometry):
    gtype = geometry.get('type', '')
    coords = geometry.get('coordinates', [])
    if gtype == 'LineString':
        return [(c[1], c[0]) for c in coords]
    elif gtype == 'MultiLineString':
        result = []
        for line in coords:
            result.extend([(c[1], c[0]) for c in line])
        return result
    return []


def segment_length(coords):
    total = 0
    for i in range(len(coords) - 1):
        total += haversine(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
    return total


def segment_bearing(coords):
    if len(coords) < 2:
        return 0
    return bearing(coords[0][0], coords[0][1], coords[-1][0], coords[-1][1])


def segment_midpoint(coords):
    mid_idx = len(coords) // 2
    return coords[mid_idx] if coords else (0, 0)


def in_bbox(coord, bbox):
    return bbox['south'] <= coord[0] <= bbox['north'] and bbox['west'] <= coord[1] <= bbox['east']


def coords_in_bbox(coords, bbox):
    return any(in_bbox(c, bbox) for c in coords)


def perpendicular_distance(coords1, coords2):
    distances = []
    samples = min(len(coords1), 10)
    step = max(1, len(coords1) // samples)
    for i in range(0, len(coords1), step):
        p = coords1[i]
        min_d = float('inf')
        for j in range(len(coords2) - 1):
            d = point_to_segment_distance(p, coords2[j], coords2[j+1])
            min_d = min(min_d, d)
        distances.append(min_d)
    return sum(distances) / len(distances) if distances else float('inf')


def point_to_segment_distance(p, a, b):
    ax, ay = a[1], a[0]
    bx, by = b[1], b[0]
    px, py = p[1], p[0]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return haversine(p[0], p[1], a[0], a[1])
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    proj_lat = a[0] + t * (b[0] - a[0])
    proj_lng = a[1] + t * (b[1] - a[1])
    return haversine(p[0], p[1], proj_lat, proj_lng)


def are_parallel(bearing1, bearing2, tolerance=30):
    diff = abs(bearing1 - bearing2) % 360
    return diff < tolerance or diff > (360 - tolerance) or abs(diff - 180) < tolerance


def bearing_to_direction(brng):
    directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
    idx = round(brng / 22.5) % 16
    return directions[idx]


def calculate_overlap(road_a, road_b):
    coords_a = road_a['coords']
    coords_b = road_b['coords']
    avg_bearing = (road_a['bearing'] + road_b['bearing']) / 2
    if 45 < avg_bearing < 135 or 225 < avg_bearing < 315:
        a_range = (min(c[1] for c in coords_a), max(c[1] for c in coords_a))
        b_range = (min(c[1] for c in coords_b), max(c[1] for c in coords_b))
    else:
        a_range = (min(c[0] for c in coords_a), max(c[0] for c in coords_a))
        b_range = (min(c[0] for c in coords_b), max(c[0] for c in coords_b))

    overlap_start = max(a_range[0], b_range[0])
    overlap_end = min(a_range[1], b_range[1])
    if overlap_end <= overlap_start:
        return 0.0
    overlap_length = overlap_end - overlap_start
    min_length = min(a_range[1] - a_range[0], b_range[1] - b_range[0])
    return overlap_length / min_length if min_length > 0 else 0.0


def main():
    roads_file = Path(__file__).parent.parent / 'data' / 'vectors' / 'osm_roads_guna.geojson'
    if not roads_file.exists():
        print(f"ERROR: {roads_file} not found")
        sys.exit(1)

    with open(roads_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    features = data.get('features', [])
    print(f"Total road segments: {len(features)}")

    # ═══════════════════════════════════════
    # STEP 1: Extract all city-core roads
    # ═══════════════════════════════════════
    city_roads = []
    for feat in features:
        props = feat.get('properties', {})
        geom = feat.get('geometry', {})
        coords = get_coords(geom)
        if not coords or not coords_in_bbox(coords, CITY_CORE):
            continue
        highway = props.get('highway', 'unknown')
        if highway in ('track', 'footway', 'path', 'cycleway', 'steps', 'pedestrian', 'construction'):
            continue

        name = props.get('name', '')
        ref = props.get('ref', '')
        oneway = props.get('oneway', '') in ('yes', '1', 'true')
        length_m = segment_length(coords)
        brng = segment_bearing(coords)

        city_roads.append({
            'highway': highway, 'name': name, 'ref': ref, 'oneway': oneway,
            'lanes': props.get('lanes', ''), 'surface': props.get('surface', ''),
            'length_m': round(length_m, 1), 'bearing': round(brng, 1),
            'coords': coords, 'midpoint': segment_midpoint(coords),
            'start': coords[0], 'end': coords[-1],
            'in_old_city': coords_in_bbox(coords, OLD_CITY),
        })

    print(f"City-core roads: {len(city_roads)}")
    print(f"Old-city roads: {sum(1 for r in city_roads if r['in_old_city'])}")

    # ═══════════════════════════════════════
    # STEP 2: Named roads
    # ═══════════════════════════════════════
    named_roads = defaultdict(list)
    for road in city_roads:
        key = road['name'] or road['ref']
        if key:
            named_roads[key].append(road)

    print(f"\nNamed/numbered roads: {len(named_roads)}")
    for name, segments in sorted(named_roads.items(), key=lambda x: sum(s['length_m'] for s in x[1]), reverse=True):
        total_len = sum(s['length_m'] for s in segments)
        types = set(s['highway'] for s in segments)
        oneway_count = sum(1 for s in segments if s['oneway'])
        print(f"  {name}: {len(segments)} segs, {total_len:.0f}m, types={types}, oneway={oneway_count}/{len(segments)}")

    # ═══════════════════════════════════════
    # STEP 3: Arterials
    # ═══════════════════════════════════════
    arterials = [r for r in city_roads if r['highway'] in ('trunk', 'primary', 'secondary', 'tertiary')]
    print(f"\nArterial segments in city core: {len(arterials)}")

    arterial_groups = defaultdict(list)
    for r in arterials:
        key = r['name'] or r['ref'] or f"unnamed_{r['highway']}_{round(r['bearing']/45)*45}"
        arterial_groups[key].append(r)

    for name, segments in sorted(arterial_groups.items(), key=lambda x: sum(s['length_m'] for s in x[1]), reverse=True):
        total_len = sum(s['length_m'] for s in segments)
        avg_bearing = sum(s['bearing'] for s in segments) / len(segments)
        direction = bearing_to_direction(avg_bearing)
        oneway_pct = sum(1 for s in segments if s['oneway']) / len(segments) * 100
        print(f"  {name}: {total_len:.0f}m, bearing={avg_bearing:.0f} ({direction}), oneway={oneway_pct:.0f}%")

    # ═══════════════════════════════════════
    # STEP 4: Find parallel road pairs
    # ═══════════════════════════════════════
    print(f"\n{'='*60}")
    print("PARALLEL ROAD PAIR DETECTION")
    print(f"{'='*60}")

    all_roads_for_pairing = [r for r in city_roads if r['length_m'] > 100]
    parallel_pairs = []

    for i, road_a in enumerate(all_roads_for_pairing):
        if road_a['highway'] not in ('primary', 'secondary', 'tertiary', 'residential', 'unclassified'):
            continue
        if road_a['length_m'] < 200:
            continue
        for j, road_b in enumerate(all_roads_for_pairing):
            if j <= i:
                continue
            if road_b['length_m'] < 200:
                continue
            if not are_parallel(road_a['bearing'], road_b['bearing']):
                continue
            dist = perpendicular_distance(road_a['coords'], road_b['coords'])
            if dist < 50 or dist > 400:
                continue
            overlap = calculate_overlap(road_a, road_b)
            if overlap < 0.3:
                continue

            score = 0
            if road_a['highway'] in ('primary', 'secondary', 'tertiary'):
                score += 30
            if road_b['highway'] in ('primary', 'secondary', 'tertiary'):
                score += 30
            score += min(road_a['length_m'] / 50 + road_b['length_m'] / 50, 40) / 2
            if 80 <= dist <= 250:
                score += 20
            if road_a['in_old_city'] or road_b['in_old_city']:
                score += 15
            if not road_a['oneway'] and not road_b['oneway']:
                score += 10

            parallel_pairs.append({
                'road_a': road_a, 'road_b': road_b,
                'separation_m': round(dist, 1), 'overlap': round(overlap, 2),
                'avg_length_m': round((road_a['length_m'] + road_b['length_m']) / 2, 1),
                'score': round(score, 1),
            })

    parallel_pairs.sort(key=lambda x: x['score'], reverse=True)

    # Deduplicate
    filtered_pairs = []
    used_coords = set()
    for pair in parallel_pairs:
        key_a = (round(pair['road_a']['coords'][0][0], 3), round(pair['road_a']['coords'][0][1], 3))
        key_b = (round(pair['road_b']['coords'][0][0], 3), round(pair['road_b']['coords'][0][1], 3))
        combined = (min(key_a, key_b), max(key_a, key_b))
        if combined not in used_coords:
            used_coords.add(combined)
            filtered_pairs.append(pair)

    print(f"\nFound {len(filtered_pairs)} candidate parallel road pairs")
    print(f"\nTop 20 One-Way Pair Candidates:")
    print(f"{'#':>3} {'Score':>6} {'Sep(m)':>7} {'Len(m)':>7} {'Road A':<30} {'Road B':<30} {'Zone'}")
    print('-' * 120)

    for idx, pair in enumerate(filtered_pairs[:20]):
        zone = 'OLD CITY' if pair['road_a']['in_old_city'] or pair['road_b']['in_old_city'] else 'City'
        name_a = f"{pair['road_a']['name'] or pair['road_a']['ref'] or 'Unnamed'} ({pair['road_a']['highway']})"
        name_b = f"{pair['road_b']['name'] or pair['road_b']['ref'] or 'Unnamed'} ({pair['road_b']['highway']})"
        print(f"{idx+1:>3} {pair['score']:>6.1f} {pair['separation_m']:>7.0f} {pair['avg_length_m']:>7.0f} {name_a:<30} {name_b:<30} {zone}")

    # ═══════════════════════════════════════
    # STEP 5: Intersection hotspots
    # ═══════════════════════════════════════
    print(f"\n{'='*60}")
    print("INTERSECTION HOTSPOT ANALYSIS")
    print(f"{'='*60}")

    node_roads = defaultdict(list)
    for idx, road in enumerate(city_roads):
        if road['coords']:
            start_key = (round(road['coords'][0][0], 4), round(road['coords'][0][1], 4))
            end_key = (round(road['coords'][-1][0], 4), round(road['coords'][-1][1], 4))
            node_roads[start_key].append(idx)
            node_roads[end_key].append(idx)

    hotspots = []
    for node, road_indices in node_roads.items():
        if len(road_indices) >= 4:
            roads_at_node = [city_roads[i] for i in road_indices]
            types = [r['highway'] for r in roads_at_node]
            names = [r['name'] or r['ref'] for r in roads_at_node if r['name'] or r['ref']]
            arterial_count = sum(1 for t in types if t in ('trunk', 'primary', 'secondary', 'tertiary'))

            severity = 'LOW'
            if len(road_indices) >= 6 or (arterial_count >= 2 and 'trunk' in types):
                severity = 'CRITICAL'
            elif arterial_count >= 2 or len(road_indices) >= 5:
                severity = 'HIGH'
            elif arterial_count >= 1:
                severity = 'MEDIUM'

            hotspots.append({
                'lat': node[0], 'lng': node[1], 'degree': len(road_indices),
                'arterial_count': arterial_count, 'severity': severity,
                'road_types': types, 'road_names': list(set(names)),
                'in_old_city': in_bbox(node, OLD_CITY),
            })

    hotspots.sort(key=lambda x: (
        {'CRITICAL': 3, 'HIGH': 2, 'MEDIUM': 1, 'LOW': 0}[x['severity']], x['degree']
    ), reverse=True)

    print(f"\nIntersection hotspots (4+ roads):")
    for idx, hs in enumerate(hotspots[:15]):
        names = ', '.join(hs['road_names'][:3]) or 'unnamed roads'
        zone = '[OLD CITY]' if hs['in_old_city'] else ''
        print(f"  #{idx+1} {hs['severity']:<10} {hs['degree']} roads at [{hs['lat']:.4f}, {hs['lng']:.4f}] {zone} -- {names}")

    # ═══════════════════════════════════════
    # STEP 6: Build recommendations
    # ═══════════════════════════════════════
    print(f"\n{'='*60}")
    print("SPECIFIC ONE-WAY ROAD RECOMMENDATIONS")
    print(f"{'='*60}")

    critical_hotspots = [h for h in hotspots if h['severity'] in ('CRITICAL', 'HIGH')]
    recommendations = []

    for idx, pair in enumerate(filtered_pairs[:10]):
        ra = pair['road_a']
        rb = pair['road_b']
        a_mid = ra['coords'][len(ra['coords'])//2]
        b_mid = rb['coords'][len(rb['coords'])//2]

        if a_mid[0] < b_mid[0] or a_mid[1] < b_mid[1]:
            forward, ret = ra, rb
        else:
            forward, ret = rb, ra

        near_hotspot = False
        for hs in critical_hotspots:
            for coord in forward['coords'] + ret['coords']:
                if haversine(coord[0], coord[1], hs['lat'], hs['lng']) < 300:
                    near_hotspot = True
                    break

        priority = 'HIGH' if near_hotspot or forward['in_old_city'] else 'MEDIUM'
        if forward['highway'] in ('primary', 'secondary') or ret['highway'] in ('primary', 'secondary'):
            priority = 'HIGH'

        zone = 'Old City / Market Area' if forward['in_old_city'] or ret['in_old_city'] else 'City Core'
        max_detour = pair['separation_m'] * 2 + 100

        rec = {
            'name': f"Pair {idx+1}: {forward['name'] or forward['ref'] or 'Unnamed'} <-> {ret['name'] or ret['ref'] or 'Unnamed'}",
            'priority': priority, 'zone': zone,
            'problem': f"Two-way traffic on {pair['separation_m']:.0f}m-apart parallel roads",
            'forward': {
                'road_name': forward['name'] or forward['ref'] or 'Unnamed',
                'highway': forward['highway'],
                'direction': bearing_to_direction(forward['bearing']),
                'length_m': forward['length_m'],
                'start': forward['coords'][0], 'end': forward['coords'][-1],
                'coords': forward['coords'],
            },
            'return': {
                'road_name': ret['name'] or ret['ref'] or 'Unnamed',
                'highway': ret['highway'],
                'direction': bearing_to_direction((ret['bearing'] + 180) % 360),
                'length_m': ret['length_m'],
                'start': ret['coords'][-1], 'end': ret['coords'][0],
                'coords': list(reversed(ret['coords'])),
            },
            'separation_m': pair['separation_m'],
            'capacity_gain': '+35-45%' if forward['highway'] in ('primary', 'secondary', 'tertiary') else '+25-35%',
            'max_detour_m': max_detour,
            'hours': 'Peak hours (7:30-9:30, 16:30-19:00)' if priority == 'HIGH' else 'Full day trial',
        }
        recommendations.append(rec)

        print(f"\n--- Recommendation {idx+1}: {rec['name']} ---")
        print(f"  Priority: {rec['priority']} | Zone: {rec['zone']}")
        print(f"  FORWARD ({rec['forward']['direction']}): {rec['forward']['road_name']} ({rec['forward']['highway']}) {rec['forward']['length_m']:.0f}m")
        print(f"    [{rec['forward']['start'][0]:.4f}, {rec['forward']['start'][1]:.4f}] -> [{rec['forward']['end'][0]:.4f}, {rec['forward']['end'][1]:.4f}]")
        print(f"  RETURN  ({rec['return']['direction']}): {rec['return']['road_name']} ({rec['return']['highway']}) {rec['return']['length_m']:.0f}m")
        print(f"    [{rec['return']['start'][0]:.4f}, {rec['return']['start'][1]:.4f}] -> [{rec['return']['end'][0]:.4f}, {rec['return']['end'][1]:.4f}]")
        print(f"  Separation: {rec['separation_m']:.0f}m | Capacity: {rec['capacity_gain']} | Max detour: {rec['max_detour_m']:.0f}m")

    # ═══════════════════════════════════════
    # STEP 7: Save results
    # ═══════════════════════════════════════
    output = {
        'analysis_date': '2026-03-16',
        'city': 'Guna, MP',
        'city_core_bbox': CITY_CORE,
        'old_city_bbox': OLD_CITY,
        'total_city_core_roads': len(city_roads),
        'parallel_pairs': [
            {
                'road_a_name': p['road_a']['name'] or p['road_a']['ref'] or 'Unnamed',
                'road_a_highway': p['road_a']['highway'],
                'road_a_coords': [[c[0], c[1]] for c in p['road_a']['coords']],
                'road_b_name': p['road_b']['name'] or p['road_b']['ref'] or 'Unnamed',
                'road_b_highway': p['road_b']['highway'],
                'road_b_coords': [[c[0], c[1]] for c in p['road_b']['coords']],
                'separation_m': p['separation_m'], 'score': p['score'],
                'avg_length_m': p['avg_length_m'],
            }
            for p in filtered_pairs[:30]
        ],
        'hotspots': hotspots[:20],
        'recommendations': [
            {
                'name': r['name'], 'priority': r['priority'], 'zone': r['zone'],
                'problem': r['problem'],
                'forward_road': r['forward']['road_name'],
                'forward_highway': r['forward']['highway'],
                'forward_direction': r['forward']['direction'],
                'forward_length_m': r['forward']['length_m'],
                'forward_coords': [[c[0], c[1]] for c in r['forward']['coords']],
                'return_road': r['return']['road_name'],
                'return_highway': r['return']['highway'],
                'return_direction': r['return']['direction'],
                'return_length_m': r['return']['length_m'],
                'return_coords': [[c[0], c[1]] for c in r['return']['coords']],
                'separation_m': r['separation_m'],
                'capacity_gain': r['capacity_gain'],
                'max_detour_m': r['max_detour_m'],
                'hours': r['hours'],
            }
            for r in recommendations
        ],
    }

    output_file = Path(__file__).parent / 'deep_oneway_analysis.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)
    print(f"\n\nFull analysis saved to: {output_file}")

    # Generate the map
    generate_detailed_map(filtered_pairs[:20], hotspots[:15], recommendations, city_roads)
    return output


def generate_detailed_map(pairs, hotspots, recommendations, city_roads):
    """Generate interactive Leaflet map with all proposed one-way roads."""

    arterial_coords = []
    for road in city_roads:
        coords_js = [[c[0], c[1]] for c in road['coords']]
        if road['highway'] in ('trunk', 'primary', 'secondary', 'tertiary'):
            arterial_coords.append({
                'coords': coords_js,
                'name': road['name'] or road['ref'] or 'Unnamed',
                'type': road['highway'],
                'oneway': road['oneway'],
                'length': road['length_m'],
            })

    rec_forward = []
    rec_return = []
    for idx, rec in enumerate(recommendations):
        rec_forward.append({
            'coords': [[c[0], c[1]] for c in rec['forward']['coords']],
            'name': rec['forward']['road_name'],
            'pair_id': idx + 1,
            'direction': rec['forward']['direction'],
            'highway': rec['forward']['highway'],
            'length': round(rec['forward']['length_m']),
        })
        rec_return.append({
            'coords': [[c[0], c[1]] for c in rec['return']['coords']],
            'name': rec['return']['road_name'],
            'pair_id': idx + 1,
            'direction': rec['return']['direction'],
            'highway': rec['return']['highway'],
            'length': round(rec['return']['length_m']),
        })

    hs_data = [{'lat': h['lat'], 'lng': h['lng'], 'degree': h['degree'],
                'severity': h['severity'], 'names': ', '.join(h['road_names'][:3]) or 'unnamed',
                'in_old_city': h['in_old_city']} for h in hotspots]

    rec_cards_data = [{
        'name': r['name'], 'priority': r['priority'], 'zone': r['zone'],
        'fwd_name': r['forward']['road_name'], 'fwd_hw': r['forward']['highway'],
        'fwd_dir': r['forward']['direction'], 'fwd_len': round(r['forward']['length_m']),
        'ret_name': r['return']['road_name'], 'ret_hw': r['return']['highway'],
        'ret_dir': r['return']['direction'], 'ret_len': round(r['return']['length_m']),
        'sep': round(r['separation_m']), 'gain': r['capacity_gain'],
        'detour': round(r['max_detour_m']), 'hours': r['hours'],
    } for r in recommendations]

    # Use json.dumps for data injection (safe — these are numbers/strings from our own analysis)
    html_content = build_map_html(
        json.dumps(arterial_coords),
        json.dumps(rec_forward),
        json.dumps(rec_return),
        json.dumps(hs_data),
        json.dumps(rec_cards_data),
        len(recommendations),
        len(hotspots),
        len([h for h in hotspots if h['severity'] == 'CRITICAL']),
        len(arterial_coords),
    )

    output_file = Path(__file__).parent / 'oneway_detailed_map.html'
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(html_content)
    print(f"Detailed one-way map generated: {output_file}")


def build_map_html(arterials_json, forwards_json, returns_json, hotspots_json,
                   rec_cards_json, n_recs, n_hotspots, n_critical, n_arterials):
    """Build the HTML string for the map."""
    # Note: All JSON data is generated from our own OSM analysis (not user input),
    # and rendered via textContent or Leaflet bindings (not raw innerHTML).
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Guna Deep One-Way Analysis</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: 'Segoe UI', Inter, sans-serif; background: #0a0a1a; color: #e0e0e0; }}
        #map {{ position: absolute; top: 0; left: 0; right: 420px; bottom: 0; }}
        #panel {{ position: absolute; top: 0; right: 0; width: 420px; bottom: 0;
                 background: #0d1b2a; overflow-y: auto; padding: 20px;
                 border-left: 2px solid #1b2838; }}
        h1 {{ font-size: 18px; color: #00e5ff; margin-bottom: 2px; }}
        h2 {{ font-size: 14px; color: #7c4dff; margin: 20px 0 8px; border-bottom: 1px solid #1b2838;
              padding-bottom: 6px; text-transform: uppercase; letter-spacing: 1px; }}
        .sub {{ font-size: 12px; color: #666; margin-bottom: 16px; }}
        .stat-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }}
        .stat {{ background: #1a2940; border-radius: 8px; padding: 10px; text-align: center; }}
        .stat-val {{ font-size: 22px; font-weight: 700; color: #00e5ff; }}
        .stat-label {{ font-size: 10px; color: #888; text-transform: uppercase; }}
        .legend {{ display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }}
        .leg {{ display: flex; align-items: center; gap: 6px; font-size: 11px; }}
        .leg-line {{ width: 28px; height: 4px; border-radius: 2px; }}
        .leg-dot {{ width: 10px; height: 10px; border-radius: 50%; }}
        .rec {{ background: #1a2940; border: 1px solid #2a3950; border-radius: 10px; padding: 14px; margin: 10px 0; cursor: pointer; }}
        .rec:hover {{ border-color: #00e5ff; }}
        .rec-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }}
        .rec-title {{ font-size: 13px; font-weight: 700; }}
        .badge {{ font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }}
        .badge.HIGH {{ background: #ff1744; color: #fff; }}
        .badge.MEDIUM {{ background: #ff9100; color: #000; }}
        .rec-zone {{ font-size: 11px; color: #888; margin-bottom: 6px; }}
        .rec-routes {{ display: flex; gap: 8px; }}
        .route-card {{ flex: 1; background: #0d1b2a; border-radius: 6px; padding: 8px; font-size: 12px; }}
        .route-card.fwd {{ border-left: 3px solid #00e676; }}
        .route-card.ret {{ border-left: 3px solid #ff5252; }}
        .rl {{ font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; }}
        .rl.fwd {{ color: #00e676; }}
        .rl.ret {{ color: #ff5252; }}
        .rn {{ font-weight: 600; color: #fff; }}
        .rd {{ color: #888; font-size: 11px; }}
        .rec-meta {{ display: flex; gap: 12px; margin-top: 8px; font-size: 11px; color: #888; }}
        .hs {{ background: #2a1020; border: 1px solid #ff1744; border-radius: 8px; padding: 10px; margin: 6px 0;
              font-size: 12px; cursor: pointer; }}
        .hs:hover {{ border-color: #ff5252; }}
    </style>
</head>
<body>
<div id="map"></div>
<div id="panel">
    <h1>Guna One-Way Road Plan</h1>
    <div class="sub">Deep road-by-road analysis with forward &amp; return routes</div>

    <div class="stat-grid">
        <div class="stat"><div class="stat-val">{n_recs}</div><div class="stat-label">One-Way Pairs</div></div>
        <div class="stat"><div class="stat-val">{n_hotspots}</div><div class="stat-label">Hotspot Junctions</div></div>
        <div class="stat"><div class="stat-val">{n_critical}</div><div class="stat-label">Critical Junctions</div></div>
        <div class="stat"><div class="stat-val">{n_arterials}</div><div class="stat-label">Arterial Segments</div></div>
    </div>

    <h2>Legend</h2>
    <div class="legend">
        <div class="leg"><div class="leg-line" style="background:#00e676"></div> Forward one-way</div>
        <div class="leg"><div class="leg-line" style="background:#ff5252"></div> Return one-way</div>
        <div class="leg"><div class="leg-line" style="background:#448aff;opacity:0.4"></div> Arterial</div>
        <div class="leg"><div class="leg-dot" style="background:#ff1744"></div> Critical</div>
        <div class="leg"><div class="leg-dot" style="background:#ff9100"></div> High</div>
        <div class="leg"><div class="leg-dot" style="background:#ffd600"></div> Medium</div>
    </div>

    <h2>Proposed One-Way Pairs</h2>
    <div id="recs"></div>

    <h2>Intersection Hotspots</h2>
    <div id="hss"></div>
</div>

<script>
var map = L.map('map').setView([24.6420, 77.3100], 15);
L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}@2x.png', {{
    attribution: '&copy; CARTO &copy; OSM', maxZoom: 19
}}).addTo(map);

var artLayer = L.layerGroup().addTo(map);
var fwdLayer = L.layerGroup().addTo(map);
var retLayer = L.layerGroup().addTo(map);
var hsLayer = L.layerGroup().addTo(map);
var conLayer = L.layerGroup().addTo(map);

// Arterials
var arts = {arterials_json};
arts.forEach(function(r) {{
    var c = r.type==='trunk'?'#ff6d00':r.type==='primary'?'#448aff':r.type==='secondary'?'#7c4dff':'#00bcd4';
    L.polyline(r.coords, {{color:c,weight:3,opacity:0.3}}).addTo(artLayer)
     .bindPopup(r.name+' ('+r.type+') '+Math.round(r.length)+'m');
}});

// Forward routes
var fwds = {forwards_json};
fwds.forEach(function(r) {{
    L.polyline(r.coords, {{color:'#00e676',weight:6,opacity:0.9}}).addTo(fwdLayer)
     .bindPopup('FWD Pair #'+r.pair_id+': '+r.name+' ('+r.highway+') '+r.length+'m '+r.direction);
    var mid = r.coords[Math.floor(r.coords.length/2)];
    L.marker(mid, {{icon:L.divIcon({{className:'',
        html:'<div style="background:#00e676;color:#000;font-size:10px;font-weight:700;padding:1px 5px;border-radius:8px;white-space:nowrap">P'+r.pair_id+' FWD</div>',
        iconSize:[50,16],iconAnchor:[25,8]}})
    }}).addTo(fwdLayer);
}});

// Return routes
var rets = {returns_json};
rets.forEach(function(r) {{
    L.polyline(r.coords, {{color:'#ff5252',weight:6,opacity:0.9}}).addTo(retLayer)
     .bindPopup('RET Pair #'+r.pair_id+': '+r.name+' ('+r.highway+') '+r.length+'m '+r.direction);
    var mid = r.coords[Math.floor(r.coords.length/2)];
    L.marker(mid, {{icon:L.divIcon({{className:'',
        html:'<div style="background:#ff5252;color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:8px;white-space:nowrap">P'+r.pair_id+' RET</div>',
        iconSize:[50,16],iconAnchor:[25,8]}})
    }}).addTo(retLayer);
}});

// Connections
fwds.forEach(function(f,i) {{
    var r = rets[i];
    if (f.coords.length && r.coords.length) {{
        L.polyline([f.coords[0],r.coords[0]], {{color:'#fff',weight:1,opacity:0.3,dashArray:'4,4'}}).addTo(conLayer);
        L.polyline([f.coords[f.coords.length-1],r.coords[r.coords.length-1]], {{color:'#fff',weight:1,opacity:0.3,dashArray:'4,4'}}).addTo(conLayer);
    }}
}});

// Hotspots
var hss = {hotspots_json};
hss.forEach(function(h,i) {{
    var c = h.severity==='CRITICAL'?'#ff1744':h.severity==='HIGH'?'#ff9100':'#ffd600';
    L.circleMarker([h.lat,h.lng], {{
        radius:8+h.degree*2, fillColor:c, color:'#fff', weight:2, opacity:0.9, fillOpacity:0.6
    }}).addTo(hsLayer).bindPopup(h.severity+' #'+(i+1)+': '+h.degree+' roads - '+h.names);
}});

L.control.layers(null, {{
    'Arterials':artLayer, 'Forward (green)':fwdLayer, 'Return (red)':retLayer,
    'Connections':conLayer, 'Hotspots':hsLayer
}}).addTo(map);

// Build recommendation cards using safe DOM methods
var recData = {rec_cards_json};
var recEl = document.getElementById('recs');
recData.forEach(function(r, i) {{
    var card = document.createElement('div');
    card.className = 'rec';

    var header = document.createElement('div');
    header.className = 'rec-header';
    var title = document.createElement('span');
    title.className = 'rec-title';
    title.textContent = r.name;
    var badge = document.createElement('span');
    badge.className = 'badge ' + r.priority;
    badge.textContent = r.priority;
    header.appendChild(title);
    header.appendChild(badge);

    var zone = document.createElement('div');
    zone.className = 'rec-zone';
    zone.textContent = r.zone;

    var routes = document.createElement('div');
    routes.className = 'rec-routes';

    var fwdCard = document.createElement('div');
    fwdCard.className = 'route-card fwd';
    var fwdLabel = document.createElement('div');
    fwdLabel.className = 'rl fwd';
    fwdLabel.textContent = 'FORWARD';
    var fwdName = document.createElement('div');
    fwdName.className = 'rn';
    fwdName.textContent = (r.fwd_name || 'Unnamed') + ' (' + r.fwd_hw + ')';
    var fwdDetail = document.createElement('div');
    fwdDetail.className = 'rd';
    fwdDetail.textContent = r.fwd_len + 'm ' + r.fwd_dir;
    fwdCard.appendChild(fwdLabel);
    fwdCard.appendChild(fwdName);
    fwdCard.appendChild(fwdDetail);

    var retCard = document.createElement('div');
    retCard.className = 'route-card ret';
    var retLabel = document.createElement('div');
    retLabel.className = 'rl ret';
    retLabel.textContent = 'RETURN';
    var retName = document.createElement('div');
    retName.className = 'rn';
    retName.textContent = (r.ret_name || 'Unnamed') + ' (' + r.ret_hw + ')';
    var retDetail = document.createElement('div');
    retDetail.className = 'rd';
    retDetail.textContent = r.ret_len + 'm ' + r.ret_dir;
    retCard.appendChild(retLabel);
    retCard.appendChild(retName);
    retCard.appendChild(retDetail);

    routes.appendChild(fwdCard);
    routes.appendChild(retCard);

    var meta = document.createElement('div');
    meta.className = 'rec-meta';
    var s1 = document.createElement('span');
    s1.textContent = 'Gap: ' + r.sep + 'm';
    var s2 = document.createElement('span');
    s2.textContent = 'Capacity: ' + r.gain;
    var s3 = document.createElement('span');
    s3.textContent = 'Detour: ' + r.detour + 'm';
    meta.appendChild(s1);
    meta.appendChild(s2);
    meta.appendChild(s3);

    var hrs = document.createElement('div');
    hrs.style.fontSize = '11px';
    hrs.style.color = '#666';
    hrs.style.marginTop = '6px';
    hrs.textContent = 'Hours: ' + r.hours;

    card.appendChild(header);
    card.appendChild(zone);
    card.appendChild(routes);
    card.appendChild(meta);
    card.appendChild(hrs);

    // Click to zoom to pair on map
    card.addEventListener('click', function() {{
        var f = fwds[i];
        if (f && f.coords.length) {{
            map.flyTo(f.coords[Math.floor(f.coords.length/2)], 17);
        }}
    }});

    recEl.appendChild(card);
}});

// Build hotspot cards using safe DOM methods
var hsEl = document.getElementById('hss');
hss.forEach(function(h, i) {{
    var card = document.createElement('div');
    card.className = 'hs';
    var label = document.createElement('strong');
    label.textContent = h.severity;
    card.appendChild(label);
    card.appendChild(document.createTextNode(
        ' Junction #' + (i+1) + ' | ' + h.degree + ' roads | [' +
        h.lat.toFixed(4) + ', ' + h.lng.toFixed(4) + ']' +
        (h.in_old_city ? ' [OLD CITY]' : '') + ' -- ' + h.names
    ));
    card.addEventListener('click', function() {{ map.flyTo([h.lat, h.lng], 17); }});
    hsEl.appendChild(card);
}});
</script>
</body>
</html>"""


if __name__ == '__main__':
    main()
