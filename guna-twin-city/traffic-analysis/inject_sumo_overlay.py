#!/usr/bin/env python3
"""
Inject SUMO simulation overlay into the oneway_detailed_map.html
Adds: one-way edge visualization, simulation metrics panel, layer control toggle
"""

import json
from pathlib import Path

WORK_DIR = Path(__file__).parent


def main():
    # Read existing map HTML
    map_file = WORK_DIR / 'oneway_detailed_map.html'
    html = map_file.read_text(encoding='utf-8')

    # Read SUMO edge data
    with open(WORK_DIR / 'sumo' / 'sumo_oneway_edges.json') as f:
        sumo_edges = json.load(f)

    # Read simulation metrics
    with open(WORK_DIR / 'sumo' / 'metrics_comparison.json') as f:
        metrics = json.load(f)

    baseline = metrics['baseline']
    oneway_m = metrics['oneway']

    # Read HD metrics
    hd_file = WORK_DIR / 'sumo' / 'metrics_highdemand.json'
    hd_data = {}
    if hd_file.exists():
        with open(hd_file) as f:
            hd_data = json.load(f)

    sumo_data_json = json.dumps(sumo_edges)

    # ── CSS ──
    sim_css = """
    .sim-section { background: #0d2137; border: 1px solid #00e5ff; border-radius: 10px; padding: 14px; margin: 10px 0; }
    .sim-title { font-size: 13px; font-weight: 700; color: #00e5ff; margin-bottom: 8px; }
    .sim-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
    .sim-label { color: #888; }
    .sim-val { font-weight: 600; }
    .sim-val.better { color: #00e676; }
    .sim-val.worse { color: #ff5252; }
    .sim-val.same { color: #888; }
    .sumo-edge-label { background: rgba(255,152,0,0.9); color: #000; font-size: 9px; font-weight: 700;
                       padding: 1px 4px; border-radius: 4px; white-space: nowrap; }
    """

    # ── JS: SUMO layer ──
    sumo_layer_js = """
// === SUMO SIMULATION OVERLAY ===
var sumoLayer = L.layerGroup().addTo(map);
var sumoEdges = SUMO_DATA_PLACEHOLDER;

sumoEdges.forEach(function(edge, i) {
    // Kept edge (forward) in amber
    L.polyline(edge.forward_coords, {
        color: '#ff9800', weight: 5, opacity: 0.9
    }).addTo(sumoLayer).bindPopup(
        '<b>KEPT (one-way): ' + edge.name + '</b><br>' +
        'Edge: ' + edge.forward_id + '<br>' +
        'Length: ' + edge.length_m + 'm'
    );

    // Removed edge (reverse) dashed red
    L.polyline(edge.reverse_coords, {
        color: '#f44336', weight: 4, opacity: 0.7, dashArray: '8,6'
    }).addTo(sumoLayer).bindPopup(
        '<b>REMOVED: ' + edge.reverse_id + '</b><br>' +
        'Reverse edge removed for one-way flow'
    );

    // Label
    var mid = edge.forward_coords[Math.floor(edge.forward_coords.length / 2)];
    L.marker(mid, {icon: L.divIcon({
        className: '',
        html: '<div class="sumo-edge-label">S' + (i+1) + '</div>',
        iconSize: [30, 14], iconAnchor: [15, 7]
    })}).addTo(sumoLayer);
});

// Old city center zone
L.circle([24.642, 77.310], {
    radius: 1000, color: '#ff9800', weight: 1, opacity: 0.4,
    fillColor: '#ff9800', fillOpacity: 0.05, dashArray: '8,4'
}).addTo(sumoLayer).bindPopup('One-way modification zone: 1km radius');

L.marker([24.642, 77.310], {icon: L.divIcon({
    className: '',
    html: '<div style="background:#ff9800;color:#000;font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;text-align:center">OLD CITY<br>CENTER</div>',
    iconSize: [70, 30], iconAnchor: [35, 15]
})}).addTo(sumoLayer);
""".replace('SUMO_DATA_PLACEHOLDER', sumo_data_json)

    # ── JS: simulation results panel ──
    b = baseline
    o = oneway_m

    metrics_800 = [
        ['Vehicles', str(b['vehicles_completed']), str(o['vehicles_completed'])],
        ['Avg Travel Time', f"{b['avg_travel_time_s']}s", f"{o['avg_travel_time_s']}s"],
        ['Avg Time Loss', f"{b['avg_time_loss_s']}s", f"{o['avg_time_loss_s']}s"],
        ['Avg Speed', f"{b['avg_speed_kmh']} km/h", f"{o['avg_speed_kmh']} km/h"],
    ]

    hd_b = hd_data.get('HD BASELINE', {})
    hd_o = hd_data.get('HD ONE-WAY', {})

    metrics_1600 = []
    if hd_b and hd_o:
        metrics_1600 = [
            ['Vehicles', str(hd_b.get('vehicles', '?')), str(hd_o.get('vehicles', '?'))],
            ['Avg Travel Time', f"{hd_b.get('avg_time', '?')}s", f"{hd_o.get('avg_time', '?')}s"],
            ['Avg Waiting', f"{hd_b.get('avg_wait', '?')}s", f"{hd_o.get('avg_wait', '?')}s"],
            ['Avg Speed', f"{hd_b.get('avg_speed', '?')} km/h", f"{hd_o.get('avg_speed', '?')} km/h"],
        ]

    m800_json = json.dumps(metrics_800)
    m1600_json = json.dumps(metrics_1600)

    sim_panel_js = f"""
// === SIMULATION RESULTS PANEL ===
(function() {{
    var panel = document.getElementById('panel');

    var heading = document.createElement('h2');
    heading.textContent = 'SUMO Simulation Results';
    heading.style.cssText = 'font-size:14px;color:#ff9800;margin:20px 0 8px;border-bottom:1px solid #1b2838;padding-bottom:6px;text-transform:uppercase;letter-spacing:1px';
    panel.appendChild(heading);

    var box = document.createElement('div');
    box.className = 'sim-section';

    function addTable(title, metrics) {{
        var t = document.createElement('div');
        t.className = 'sim-title';
        t.textContent = title;
        box.appendChild(t);

        var hdr = document.createElement('div');
        hdr.className = 'sim-row';
        hdr.style.fontWeight = '600';
        hdr.style.color = '#aaa';
        ['Metric', 'Baseline', 'One-Way'].forEach(function(h, j) {{
            var s = document.createElement('span');
            s.textContent = h;
            s.style.flex = j === 0 ? '1.5' : '1';
            if (j > 0) s.style.textAlign = 'right';
            hdr.appendChild(s);
        }});
        box.appendChild(hdr);

        metrics.forEach(function(m) {{
            var row = document.createElement('div');
            row.className = 'sim-row';
            m.forEach(function(val, j) {{
                var s = document.createElement('span');
                s.textContent = val;
                s.className = j === 0 ? 'sim-label' : 'sim-val same';
                s.style.flex = j === 0 ? '1.5' : '1';
                if (j > 0) s.style.textAlign = 'right';
                row.appendChild(s);
            }});
            box.appendChild(row);
        }});
    }}

    addTable('Moderate Demand (800 veh/hr)', {m800_json});

    var m1600 = {m1600_json};
    if (m1600.length > 0) {{
        var spacer = document.createElement('div');
        spacer.style.height = '12px';
        box.appendChild(spacer);
        addTable('Peak Hour (1600 veh/hr)', m1600);
    }}

    var verdict = document.createElement('div');
    verdict.style.cssText = 'margin-top:12px;padding:8px;background:#0a3020;border:1px solid #00e676;border-radius:6px;font-size:11px;color:#00e676;text-align:center';
    verdict.textContent = 'VERDICT: One-way conversion is VIABLE. Minimal penalty at moderate demand, 23% waiting reduction at peak.';
    box.appendChild(verdict);

    var note = document.createElement('div');
    note.style.cssText = 'margin-top:8px;font-size:10px;color:#666';
    note.textContent = 'Orange = kept (one-way). Red dashed = removed. Circle = 1km zone. 15 edges modified.';
    box.appendChild(note);

    panel.appendChild(box);
}})();
"""

    # ── Inject into HTML ──
    # 1. CSS before </style>
    html = html.replace('</style>', sim_css + '    </style>')

    # 2. Add sumoLayer to layer control
    html = html.replace(
        "'Hotspots':hsLayer",
        "'Hotspots':hsLayer, 'SUMO Simulation':sumoLayer"
    )

    # 3. Add JS before </script>
    html = html.replace('</script>', sumo_layer_js + sim_panel_js + '\n</script>')

    # Write
    map_file.write_text(html, encoding='utf-8')
    print(f"Updated oneway_detailed_map.html with SUMO simulation overlay")
    print(f"  - {len(sumo_edges)} one-way edges visualized (orange=kept, red dashed=removed)")
    print(f"  - Simulation metrics panel added to sidebar")
    print(f"  - Layer control includes 'SUMO Simulation' toggle")


if __name__ == '__main__':
    main()
