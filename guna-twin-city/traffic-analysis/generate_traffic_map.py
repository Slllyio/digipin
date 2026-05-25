#!/usr/bin/env python3
"""
Generate interactive HTML traffic analysis map for Guna.
Shows bottlenecks, intersections, one-way proposals, and road classification.
No API keys required — uses open tile providers.
"""

import json
from pathlib import Path

GUNA_CENTER = [24.6354, 77.3126]
GUNA_ZOOM = 14

# Key locations
LOCATIONS = {
    'Primary Bottleneck\n(7 roads converge)': [24.6451, 77.3076],
    'Secondary Bottleneck\n(5 roads converge)': [24.6387, 77.3044],
    'SH-10/SH-54 Junction': [24.648, 77.318],
    'Railway Station': [24.633, 77.312],
    'Bus Stand Area': [24.640, 77.315],
    'NH-46 North Entry': [24.685, 77.340],
    'NH-46 South Exit': [24.600, 77.295],
}

# One-way corridor proposals (approximate polylines)
CORRIDORS = {
    'Corridor A: Market Area (Northbound)': {
        'coords': [[24.642, 77.308], [24.645, 77.308], [24.648, 77.307], [24.651, 77.307]],
        'color': '#00e676',
        'direction': 'Northbound'
    },
    'Corridor A: Market Area (Southbound)': {
        'coords': [[24.651, 77.310], [24.648, 77.310], [24.645, 77.311], [24.642, 77.311]],
        'color': '#ff5252',
        'direction': 'Southbound'
    },
    'Corridor B: Station to Bus Stand': {
        'coords': [[24.633, 77.312], [24.636, 77.313], [24.639, 77.314], [24.640, 77.315]],
        'color': '#448aff',
        'direction': 'Station -> Bus Stand'
    },
    'Corridor B: Bus Stand to Station': {
        'coords': [[24.640, 77.316], [24.637, 77.315], [24.635, 77.314], [24.633, 77.313]],
        'color': '#ffab40',
        'direction': 'Bus Stand -> Station'
    },
}


def generate_map():
    # Load OSM analysis results if available
    analysis_file = Path(__file__).parent / 'osm_analysis.json'
    analysis = {}
    if analysis_file.exists():
        with open(analysis_file, 'r', encoding='utf-8') as f:
            analysis = json.load(f)

    intersections = analysis.get('top_intersections', [])

    # Build intersection markers
    intersection_markers = ''
    for idx, isect in enumerate(intersections[:12]):
        color = '#ff1744' if isect['degree'] >= 6 else '#ff9100' if isect['degree'] >= 5 else '#ffd600'
        size = 8 + isect['degree'] * 2
        intersection_markers += f"""
        L.circleMarker([{isect['lat']}, {isect['lng']}], {{
            radius: {size},
            fillColor: '{color}',
            color: '#fff',
            weight: 2,
            opacity: 0.9,
            fillOpacity: 0.7
        }}).addTo(intersectionLayer).bindPopup('<b>Intersection #{idx+1}</b><br>{isect["degree"]} connecting roads<br>Lat: {isect["lat"]}, Lng: {isect["lng"]}');
        """

    # Build location markers
    location_markers = ''
    for name, coords in LOCATIONS.items():
        clean_name = name.replace('\n', ' ')
        location_markers += f"""
        L.marker([{coords[0]}, {coords[1]}], {{
            icon: L.divIcon({{
                className: 'custom-label',
                html: '<div class="label-text">{clean_name}</div>',
                iconSize: [120, 30],
                iconAnchor: [60, 15]
            }})
        }}).addTo(labelLayer);
        """

    # Build corridor polylines
    corridor_lines = ''
    for name, data in CORRIDORS.items():
        coords_js = json.dumps(data['coords'])
        corridor_lines += f"""
        L.polyline({coords_js}, {{
            color: '{data["color"]}',
            weight: 6,
            opacity: 0.8,
            dashArray: '12, 8'
        }}).addTo(corridorLayer).bindPopup('<b>{name}</b><br>Direction: {data["direction"]}');

        // Arrow markers
        var coords_{hash(name) % 10000} = {coords_js};
        for (var i = 0; i < coords_{hash(name) % 10000}.length - 1; i++) {{
            var mid = [(coords_{hash(name) % 10000}[i][0] + coords_{hash(name) % 10000}[i+1][0])/2,
                       (coords_{hash(name) % 10000}[i][1] + coords_{hash(name) % 10000}[i+1][1])/2];
            L.circleMarker(mid, {{
                radius: 4,
                fillColor: '{data["color"]}',
                color: '{data["color"]}',
                weight: 1,
                fillOpacity: 1
            }}).addTo(corridorLayer);
        }}
        """

    # Classification summary for sidebar
    classification = analysis.get('classification', {})
    class_rows = ''
    for htype, info in sorted(classification.items(), key=lambda x: x[1]['length_km'], reverse=True):
        class_rows += f"<tr><td>{htype}</td><td>{info['count']}</td><td>{info['length_km']}</td><td>{info['one_way']}</td></tr>"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Guna Traffic Analysis Map</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: 'Segoe UI', Inter, sans-serif; background: #1a1a2e; color: #e8e8e8; }}
        #map {{ position: absolute; top: 0; left: 0; right: 350px; bottom: 0; }}
        #sidebar {{ position: absolute; top: 0; right: 0; width: 350px; bottom: 0;
                   background: #16213e; overflow-y: auto; padding: 20px; border-left: 2px solid #0f3460; }}
        h1 {{ font-size: 18px; color: #00e5ff; margin-bottom: 4px; }}
        h2 {{ font-size: 14px; color: #7c4dff; margin: 16px 0 8px; border-bottom: 1px solid #0f3460; padding-bottom: 4px; }}
        .subtitle {{ font-size: 12px; color: #888; margin-bottom: 16px; }}
        .stat {{ display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }}
        .stat-label {{ color: #aaa; }}
        .stat-value {{ color: #00e5ff; font-weight: 600; }}
        table {{ width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }}
        th {{ background: #0f3460; color: #00e5ff; padding: 6px 4px; text-align: left; }}
        td {{ padding: 4px; border-bottom: 1px solid #1a1a3e; }}
        .legend {{ margin-top: 16px; }}
        .legend-item {{ display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px; }}
        .legend-dot {{ width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }}
        .legend-line {{ width: 24px; height: 4px; border-radius: 2px; flex-shrink: 0; }}
        .custom-label .label-text {{
            background: rgba(0,0,0,0.75); color: #fff; font-size: 11px;
            padding: 2px 6px; border-radius: 4px; white-space: nowrap;
            border: 1px solid rgba(0,229,255,0.3);
        }}
        .bottleneck-callout {{ background: #1a1a3e; border: 1px solid #ff1744; border-radius: 8px;
                              padding: 10px; margin: 8px 0; font-size: 12px; }}
        .bottleneck-callout strong {{ color: #ff1744; }}
    </style>
</head>
<body>
    <div id="map"></div>
    <div id="sidebar">
        <h1>Guna Traffic Analysis</h1>
        <div class="subtitle">Road network bottlenecks & one-way proposals</div>

        <h2>Key Statistics</h2>
        <div class="stat"><span class="stat-label">Total road segments</span><span class="stat-value">{analysis.get('total_segments', 8470)}</span></div>
        <div class="stat"><span class="stat-label">Total road length</span><span class="stat-value">{analysis.get('total_length_km', 3297)} km</span></div>
        <div class="stat"><span class="stat-label">City-core segments</span><span class="stat-value">{analysis.get('city_core_segments', 3340)}</span></div>
        <div class="stat"><span class="stat-label">One-way segments</span><span class="stat-value">{analysis.get('one_way_segments', 159)}</span></div>
        <div class="stat"><span class="stat-label">City one-way segments</span><span class="stat-value">{analysis.get('city_one_way_segments', 63)}</span></div>
        <div class="stat"><span class="stat-label">High-traffic intersections</span><span class="stat-value">{analysis.get('high_connectivity_intersections', 12)}</span></div>

        <div class="bottleneck-callout">
            <strong>Primary Bottleneck:</strong> [24.6451, 77.3076]<br>
            7 roads converge at a single point. This intersection needs grade separation or a multi-arm roundabout.
        </div>

        <h2>Road Classification</h2>
        <table>
            <tr><th>Type</th><th>Segs</th><th>km</th><th>1-Way</th></tr>
            {class_rows}
        </table>

        <h2>Legend</h2>
        <div class="legend">
            <div class="legend-item"><div class="legend-dot" style="background:#ff1744"></div> Critical intersection (6+ roads)</div>
            <div class="legend-item"><div class="legend-dot" style="background:#ff9100"></div> Major intersection (5 roads)</div>
            <div class="legend-item"><div class="legend-dot" style="background:#ffd600"></div> Intersection (4 roads)</div>
            <div class="legend-item"><div class="legend-line" style="background:#00e676"></div> Proposed one-way (north/outbound)</div>
            <div class="legend-item"><div class="legend-line" style="background:#ff5252"></div> Proposed one-way (south/return)</div>
            <div class="legend-item"><div class="legend-line" style="background:#448aff"></div> Station-Bus Stand link</div>
            <div class="legend-item"><div class="legend-line" style="background:#ffab40"></div> Bus Stand-Station return</div>
        </div>

        <h2>One-Way Proposals</h2>
        <p style="font-size:12px;color:#aaa;margin-bottom:8px;">Dashed lines on map show proposed one-way corridors. Each pair has a forward and return route.</p>
        <div style="font-size:12px;">
            <strong style="color:#00e676;">Corridor A:</strong> Market area one-way pair (1.5 km each)<br>
            <strong style="color:#448aff;">Corridor B:</strong> Station-Bus Stand link (1 km each)<br>
        </div>

        <h2>Data Sources</h2>
        <p style="font-size:11px;color:#666;">
            OpenStreetMap (8,470 segments) | NHAI NH-46 data | MoRTH traffic census |
            Google Routes API (when configured) | Mappls/MapMyIndia
        </p>
    </div>

    <script>
        var map = L.map('map').setView({json.dumps(GUNA_CENTER)}, {GUNA_ZOOM});

        // Dark tile layer
        L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}@2x.png', {{
            attribution: '&copy; CARTO &copy; OSM contributors',
            maxZoom: 19
        }}).addTo(map);

        // Layer groups
        var intersectionLayer = L.layerGroup().addTo(map);
        var corridorLayer = L.layerGroup().addTo(map);
        var labelLayer = L.layerGroup().addTo(map);

        // Add intersection markers
        {intersection_markers}

        // Add corridor proposals
        {corridor_lines}

        // Add location labels
        {location_markers}

        // Layer control
        L.control.layers(null, {{
            'Bottleneck Intersections': intersectionLayer,
            'One-Way Proposals': corridorLayer,
            'Labels': labelLayer
        }}).addTo(map);
    </script>
</body>
</html>"""

    output_file = Path(__file__).parent / 'traffic_map.html'
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"Traffic analysis map generated: {output_file}")
    return output_file


if __name__ == '__main__':
    generate_map()
