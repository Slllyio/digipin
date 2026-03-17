/**
 * Mob Simulation & Force Deployment Module — Guna Digital Twin
 * =============================================================
 * Crowd management intelligence for law enforcement:
 *
 *  1. Road Capacity Layer — IRC-standard widths, Fruin LoS coloring
 *  2. Sensitive Infrastructure — temples, mosques, markets, schools, police
 *  3. Crowd Event Simulator — place crowd events, compute density propagation
 *  4. Force Deployment Panel — police stations, isochrones, force calculator
 *  5. Section 144 Zone Tool — draw restricted zones with tiered severity
 *
 * SECURITY: All DOM built via createElement / textContent. No innerHTML.
 */

const MobSimulation = (() => {
    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    const BBOX_CITY = { west: 77.25, south: 24.58, east: 77.38, north: 24.70 };
    const DATA_BASE = './data';

    const IRC_WIDTHS = {
        trunk: 12, trunk_link: 8, primary: 9, primary_link: 6,
        secondary: 7, secondary_link: 5, tertiary: 5.5, tertiary_link: 4,
        residential: 5, unclassified: 4, living_street: 4, service: 3,
        track: 3, footway: 1.5, cycleway: 2, path: 1.5, pedestrian: 3, steps: 1.5
    };

    const INFRA_COLORS = {
        hindu_temple: '#FF6B00', mosque: '#00C853', jain_temple: '#FFD600',
        church: '#2196F3', other_worship: '#9C27B0', market: '#FF5252',
        school: '#42A5F5', hospital: '#EF5350', police: '#1565C0', fire_station: '#D32F2F'
    };

    const FRUIN_LEVELS = [
        { max: 0.7, color: '#4CAF50', label: 'Safe (A)' },
        { max: 2.0, color: '#FFEB3B', label: 'Moderate (B-C)' },
        { max: 4.0, color: '#FF9800', label: 'Dangerous (D)' },
        { max: 6.0, color: '#F44336', label: 'Crush Risk (E)' },
        { max: Infinity, color: '#000000', label: 'Lethal (F)' }
    ];

    const POLICE_STATIONS = [
        { name: 'Kotwali', lat: 24.6372, lng: 77.3115 },
        { name: 'City Kotwali', lat: 24.6415, lng: 77.3185 },
        { name: 'Cantt', lat: 24.6280, lng: 77.3050 }
    ];

    const FORCE_RATIOS = { peaceful: 50, tense: 15, riot: 6 };

    let _map = null;
    let _roadsData = null;
    let _infraData = null;
    let _events = [];
    let _cordons = [];
    let _s144Zones = [];
    let _placingEvent = false;
    let _drawingCordon = false;
    let _drawingS144 = false;
    let _s144Points = [];
    let _activeTab = 'roads';
    let _panel = null;
    let _infraVisible = {};

    // ═══════════════════════════════════════════════════════════════
    // SAFE DOM HELPERS
    // ═══════════════════════════════════════════════════════════════

    function _el(tag, attrs, children) {
        const el = document.createElement(tag);
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
                if (k === 'style' && typeof v === 'object') {
                    Object.assign(el.style, v);
                } else if (k === 'className') {
                    el.className = v;
                } else if (k.startsWith('on')) {
                    el.addEventListener(k.slice(2).toLowerCase(), v);
                } else {
                    el.setAttribute(k, v);
                }
            }
        }
        if (children != null) {
            if (typeof children === 'string') el.textContent = children;
            else if (Array.isArray(children)) children.forEach(c => { if (c) el.appendChild(c); });
            else el.appendChild(children);
        }
        return el;
    }

    function _toast(msg) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const t = _el('div', { className: 'toast' }, msg);
        container.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    }

    function _getMap() {
        if (!_map && typeof MapModule !== 'undefined') {
            _map = MapModule.getMap();
        }
        return _map;
    }

    // ═══════════════════════════════════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════════════════════════════════

    function _haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function _lineLength(coords) {
        let total = 0;
        for (let i = 1; i < coords.length; i++) {
            total += _haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
        }
        return total;
    }

    function _lineMidpoint(coords) {
        const mid = Math.floor(coords.length / 2);
        return coords[mid] || coords[0];
    }

    function _pointInPolygon(point, polygon) {
        const [x, y] = point;
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const [xi, yi] = polygon[i];
            const [xj, yj] = polygon[j];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    function _crowdRadius(size) {
        if (size <= 500) return 300;
        if (size <= 1000) return 500;
        if (size <= 2000) return 800;
        if (size <= 5000) return 1200;
        return 1800;
    }

    function _fruinColor(density) {
        for (const level of FRUIN_LEVELS) {
            if (density < level.max) return level.color;
        }
        return '#000000';
    }

    // ═══════════════════════════════════════════════════════════════
    // 1. ROAD CAPACITY LAYER
    // ═══════════════════════════════════════════════════════════════

    const RoadCapacity = (() => {
        let _visible = false;

        async function load() {
            const map = _getMap();
            if (!map) return;

            try {
                let resp = await fetch(`${DATA_BASE}/vectors/roads_crowd_capacity_guna.geojson`);
                if (!resp.ok) {
                    resp = await fetch(`${DATA_BASE}/vectors/osm_roads_guna.geojson`);
                    if (!resp.ok) throw new Error('No road data available');
                    const raw = await resp.json();
                    _roadsData = _computeCapacity(raw);
                } else {
                    _roadsData = await resp.json();
                }
                _addLayers();
                _toast('Road capacity layer loaded');
            } catch (err) {
                _toast('Error loading roads: ' + err.message);
            }
        }

        function _computeCapacity(geojson) {
            const features = (geojson.features || []).map(f => {
                const props = { ...f.properties };
                const highway = props.highway || 'unclassified';
                const width = IRC_WIDTHS[highway] || 4;
                const coords = f.geometry?.type === 'LineString' ? f.geometry.coordinates :
                    f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates[0] : [];
                const length = _lineLength(coords);
                const capacityPerMeter = width / 0.46;
                const maxCapacity = Math.floor(capacityPerMeter * length);
                const crowdRisk = width >= 7 ? 'low' : width >= 4 ? 'medium' : width >= 2 ? 'high' : 'critical';

                return {
                    ...f,
                    properties: {
                        ...props,
                        width,
                        length: Math.round(length),
                        max_capacity: maxCapacity,
                        max_flow_rate: Math.round(width * 1.2 * 60),
                        crowd_risk: crowdRisk
                    }
                };
            });
            return { type: 'FeatureCollection', features };
        }

        function _addLayers() {
            const map = _getMap();
            if (!map || map.getSource('mob-roads')) return;

            map.addSource('mob-roads', { type: 'geojson', data: _roadsData });

            map.addLayer({
                id: 'mob-roads-layer',
                type: 'line',
                source: 'mob-roads',
                paint: {
                    'line-color': [
                        'match', ['get', 'crowd_risk'],
                        'low', '#4CAF50',
                        'medium', '#FFEB3B',
                        'high', '#FF9800',
                        'critical', '#F44336',
                        '#999999'
                    ],
                    'line-width': [
                        'interpolate', ['linear'], ['zoom'],
                        10, ['/', ['get', 'width'], 6],
                        14, ['/', ['get', 'width'], 2],
                        18, ['get', 'width']
                    ],
                    'line-opacity': 0.8
                },
                layout: { visibility: 'visible' }
            });

            _addChokepoints();
            _addClickHandler();
            _visible = true;
        }

        function _addChokepoints() {
            const map = _getMap();
            if (!map || !_roadsData) return;

            const chokepoints = _roadsData.features
                .filter(f => f.properties.crowd_risk === 'critical' || f.properties.crowd_risk === 'high')
                .map(f => {
                    const coords = f.geometry?.type === 'LineString' ? f.geometry.coordinates :
                        f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates[0] : [];
                    const mid = _lineMidpoint(coords);
                    return {
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: mid },
                        properties: { name: f.properties.name || 'Unnamed', width: f.properties.width, crowd_risk: f.properties.crowd_risk }
                    };
                });

            if (map.getSource('mob-chokepoints')) return;

            map.addSource('mob-chokepoints', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: chokepoints }
            });

            map.addLayer({
                id: 'mob-chokepoints-layer',
                type: 'circle',
                source: 'mob-chokepoints',
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#F44336',
                    'circle-stroke-color': '#fff',
                    'circle-stroke-width': 2,
                    'circle-opacity': 0.9
                }
            });
        }

        function _addClickHandler() {
            const map = _getMap();
            if (!map) return;

            map.on('click', 'mob-roads-layer', (e) => {
                const props = e.features?.[0]?.properties;
                if (!props) return;

                const content = _el('div', { style: { padding: '8px', minWidth: '200px' } }, [
                    _el('strong', {}, props.name || 'Unnamed Road'),
                    _el('br'),
                    _el('span', {}, 'Type: ' + (props.highway || 'unknown')),
                    _el('br'),
                    _el('span', {}, 'Width: ' + props.width + 'm (IRC)'),
                    _el('br'),
                    _el('span', {}, 'Capacity: ' + (props.max_capacity || '—') + ' persons'),
                    _el('br'),
                    _el('span', {}, 'Max Flow: ' + (props.max_flow_rate || '—') + ' p/min'),
                    _el('br'),
                    _el('span', { style: { fontWeight: 'bold', color: props.crowd_risk === 'critical' ? '#F44336' : '#FF9800' } },
                        'Risk: ' + (props.crowd_risk || 'unknown').toUpperCase())
                ]);

                new maplibregl.Popup({ maxWidth: '280px' })
                    .setLngLat(e.lngLat)
                    .setDOMContent(content)
                    .addTo(map);
            });

            map.on('mouseenter', 'mob-roads-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', 'mob-roads-layer', () => { map.getCanvas().style.cursor = ''; });
        }

        function toggle() {
            const map = _getMap();
            if (!map) return;

            if (!map.getSource('mob-roads')) {
                load();
                return;
            }

            _visible = !_visible;
            const vis = _visible ? 'visible' : 'none';
            if (map.getLayer('mob-roads-layer')) map.setLayoutProperty('mob-roads-layer', 'visibility', vis);
            if (map.getLayer('mob-chokepoints-layer')) map.setLayoutProperty('mob-chokepoints-layer', 'visibility', vis);
        }

        function isVisible() { return _visible; }

        return { load, toggle, isVisible };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 2. SENSITIVE INFRASTRUCTURE LAYER
    // ═══════════════════════════════════════════════════════════════

    const SensitiveInfra = (() => {
        let _visible = false;

        async function load() {
            const map = _getMap();
            if (!map) return;

            try {
                let resp = await fetch(`${DATA_BASE}/vectors/sensitive_infrastructure_guna.geojson`);
                if (resp.ok) {
                    _infraData = await resp.json();
                } else {
                    _infraData = await _queryOverpass();
                }
                _classifyFeatures();
                _addLayers();
                _toast('Sensitive infrastructure loaded');
            } catch (err) {
                _toast('Error loading infrastructure: ' + err.message);
            }
        }

        async function _queryOverpass() {
            const bbox = `${BBOX_CITY.south},${BBOX_CITY.west},${BBOX_CITY.north},${BBOX_CITY.east}`;
            const query = `[out:json][timeout:30];(
                node["amenity"="place_of_worship"](${bbox});
                node["amenity"="school"](${bbox});
                node["amenity"="hospital"](${bbox});
                node["amenity"="police"](${bbox});
                node["amenity"="fire_station"](${bbox});
                node["amenity"="marketplace"](${bbox});
                node["shop"="mall"](${bbox});
            );out body;`;

            const resp = await fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                body: 'data=' + encodeURIComponent(query)
            });
            if (!resp.ok) throw new Error('Overpass API failed');
            const data = await resp.json();

            const features = (data.elements || []).map(el => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
                properties: {
                    name: el.tags?.name || 'Unnamed',
                    amenity: el.tags?.amenity || el.tags?.shop || '',
                    religion: el.tags?.religion || '',
                    denomination: el.tags?.denomination || ''
                }
            }));
            return { type: 'FeatureCollection', features };
        }

        function _classifyFeatures() {
            if (!_infraData?.features) return;
            _infraData.features.forEach(f => {
                const p = f.properties;
                const amenity = (p.amenity || '').toLowerCase();
                const religion = (p.religion || '').toLowerCase();

                if (amenity === 'place_of_worship') {
                    if (religion === 'hindu') p.category = 'hindu_temple';
                    else if (religion === 'muslim' || religion === 'islam') p.category = 'mosque';
                    else if (religion === 'jain') p.category = 'jain_temple';
                    else if (religion === 'christian') p.category = 'church';
                    else p.category = 'other_worship';
                } else if (amenity === 'marketplace' || amenity === 'mall' || p.shop) {
                    p.category = 'market';
                } else if (amenity === 'school') {
                    p.category = 'school';
                } else if (amenity === 'hospital') {
                    p.category = 'hospital';
                } else if (amenity === 'police') {
                    p.category = 'police';
                } else if (amenity === 'fire_station') {
                    p.category = 'fire_station';
                } else {
                    p.category = 'other_worship';
                }
            });

            Object.keys(INFRA_COLORS).forEach(cat => { _infraVisible[cat] = true; });
        }

        function _addLayers() {
            const map = _getMap();
            if (!map || !_infraData || map.getSource('mob-infra')) return;

            map.addSource('mob-infra', { type: 'geojson', data: _infraData });

            const colorExpr = ['match', ['get', 'category']];
            Object.entries(INFRA_COLORS).forEach(([cat, color]) => {
                colorExpr.push(cat, color);
            });
            colorExpr.push('#9E9E9E');

            map.addLayer({
                id: 'mob-infra-layer',
                type: 'circle',
                source: 'mob-infra',
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 8, 18, 14],
                    'circle-color': colorExpr,
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                    'circle-opacity': 0.9
                }
            });

            map.on('click', 'mob-infra-layer', (e) => {
                const props = e.features?.[0]?.properties;
                if (!props) return;

                const content = _el('div', { style: { padding: '8px' } }, [
                    _el('strong', {}, props.name || 'Unnamed'),
                    _el('br'),
                    _el('span', {}, 'Type: ' + (props.amenity || 'unknown')),
                    _el('br'),
                    _el('span', {}, 'Religion: ' + (props.religion || '—')),
                    _el('br'),
                    _el('span', { style: { color: INFRA_COLORS[props.category] || '#999' } },
                        'Category: ' + (props.category || '').replace(/_/g, ' '))
                ]);

                new maplibregl.Popup({ maxWidth: '250px' })
                    .setLngLat(e.lngLat)
                    .setDOMContent(content)
                    .addTo(map);
            });

            map.on('mouseenter', 'mob-infra-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', 'mob-infra-layer', () => { map.getCanvas().style.cursor = ''; });
            _visible = true;
        }

        function toggle() {
            const map = _getMap();
            if (!map) return;
            if (!map.getSource('mob-infra')) { load(); return; }
            _visible = !_visible;
            if (map.getLayer('mob-infra-layer')) {
                map.setLayoutProperty('mob-infra-layer', 'visibility', _visible ? 'visible' : 'none');
            }
        }

        function toggleCategory(category) {
            _infraVisible[category] = !_infraVisible[category];
            _applyFilter();
        }

        function _applyFilter() {
            const map = _getMap();
            if (!map || !map.getLayer('mob-infra-layer')) return;
            const visibleCats = Object.entries(_infraVisible)
                .filter(([, v]) => v)
                .map(([k]) => k);
            map.setFilter('mob-infra-layer', ['in', 'category', ...visibleCats]);
        }

        function isVisible() { return _visible; }

        return { load, toggle, toggleCategory, isVisible };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 3. CROWD EVENT SIMULATOR
    // ═══════════════════════════════════════════════════════════════

    const CrowdSim = (() => {
        let _eventMarkers = [];
        let _simLayerAdded = false;

        function startPlacing() {
            const map = _getMap();
            if (!map) return;
            _placingEvent = true;
            map.getCanvas().style.cursor = 'crosshair';
            _toast('Click on map to place crowd event');

            const handler = (e) => {
                map.off('click', handler);
                _placingEvent = false;
                map.getCanvas().style.cursor = '';
                _showEventDialog(e.lngLat);
            };
            map.on('click', handler);
        }

        function _showEventDialog(lngLat) {
            const existing = document.getElementById('mob-event-dialog');
            if (existing) existing.remove();

            const dialog = _el('div', {
                id: 'mob-event-dialog',
                className: 'floating-dialog open',
                style: {
                    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    zIndex: '9999', background: '#1a1a2e', border: '1px solid #444',
                    borderRadius: '8px', padding: '20px', minWidth: '280px'
                }
            });

            dialog.appendChild(_el('h3', { style: { margin: '0 0 12px', color: '#fff', fontSize: '15px' } }, 'Place Crowd Event'));

            const sizeLabel = _el('label', { style: { color: '#ccc', fontSize: '13px', display: 'block', marginBottom: '4px' } }, 'Crowd Size');
            const sizeSelect = _el('select', {
                id: 'mob-crowd-size',
                style: { width: '100%', padding: '6px', marginBottom: '12px', background: '#2a2a3e', color: '#fff', border: '1px solid #555', borderRadius: '4px' }
            });
            [500, 1000, 2000, 5000, 10000].forEach(s => {
                sizeSelect.appendChild(_el('option', { value: String(s) }, String(s) + ' people'));
            });

            const typeLabel = _el('label', { style: { color: '#ccc', fontSize: '13px', display: 'block', marginBottom: '4px' } }, 'Event Type');
            const typeSelect = _el('select', {
                id: 'mob-event-type',
                style: { width: '100%', padding: '6px', marginBottom: '16px', background: '#2a2a3e', color: '#fff', border: '1px solid #555', borderRadius: '4px' }
            });
            ['procession', 'rally', 'market', 'riot'].forEach(t => {
                typeSelect.appendChild(_el('option', { value: t }, t.charAt(0).toUpperCase() + t.slice(1)));
            });

            const btnRow = _el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } });

            const cancelBtn = _el('button', {
                style: { padding: '6px 14px', background: '#555', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' },
                onClick: () => dialog.remove()
            }, 'Cancel');

            const placeBtn = _el('button', {
                style: { padding: '6px 14px', background: '#F44336', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' },
                onClick: () => {
                    const size = parseInt(sizeSelect.value, 10);
                    const type = typeSelect.value;
                    dialog.remove();
                    _placeEvent(lngLat, size, type);
                }
            }, 'Place Event');

            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(placeBtn);

            dialog.appendChild(sizeLabel);
            dialog.appendChild(sizeSelect);
            dialog.appendChild(typeLabel);
            dialog.appendChild(typeSelect);
            dialog.appendChild(btnRow);

            document.body.appendChild(dialog);
        }

        function _placeEvent(lngLat, crowdSize, eventType) {
            const map = _getMap();
            if (!map) return;

            const event = { id: 'evt-' + Date.now(), lngLat, crowdSize, eventType };
            _events.push(event);

            const markerEl = _el('div', {
                style: {
                    width: '24px', height: '24px', borderRadius: '50%',
                    background: eventType === 'riot' ? '#F44336' : '#FF9800',
                    border: '3px solid #fff', cursor: 'pointer', boxShadow: '0 0 8px rgba(0,0,0,0.5)'
                }
            });

            const marker = new maplibregl.Marker({ element: markerEl })
                .setLngLat([lngLat.lng, lngLat.lat])
                .addTo(map);
            _eventMarkers.push(marker);

            _simulateCrowdSpread(event);
            _toast('Crowd event placed: ' + crowdSize + ' people (' + eventType + ')');
        }

        function _simulateCrowdSpread(event) {
            const map = _getMap();
            if (!map || !_roadsData?.features) return;

            const radius = _crowdRadius(event.crowdSize);
            const center = [event.lngLat.lng, event.lngLat.lat];

            const affectedRoads = _roadsData.features
                .map(f => {
                    const coords = f.geometry?.type === 'LineString' ? f.geometry.coordinates :
                        f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates[0] : [];
                    if (coords.length === 0) return null;
                    const mid = _lineMidpoint(coords);
                    const dist = _haversine(center[1], center[0], mid[1], mid[0]);
                    if (dist > radius) return null;
                    return { feature: f, dist, coords };
                })
                .filter(Boolean)
                .sort((a, b) => a.dist - b.dist);

            let remainingCrowd = event.crowdSize;
            const densityFeatures = [];

            for (const road of affectedRoads) {
                if (remainingCrowd <= 0) break;
                const props = road.feature.properties;
                const length = props.length || _lineLength(road.coords);
                const width = props.width || 4;
                const area = length * width;
                const proximityFactor = 1 - (road.dist / radius);
                const crowdInSegment = Math.min(remainingCrowd * proximityFactor * 0.3, area * 6);
                remainingCrowd -= crowdInSegment;

                const density = area > 0 ? crowdInSegment / area : 0;
                const color = _fruinColor(density);

                densityFeatures.push({
                    ...road.feature,
                    properties: {
                        ...props,
                        sim_density: Math.round(density * 100) / 100,
                        sim_crowd: Math.round(crowdInSegment),
                        sim_color: color,
                        sim_event_id: event.id
                    }
                });
            }

            const sourceId = 'mob-sim-' + event.id;
            const layerId = 'mob-sim-layer-' + event.id;

            if (map.getSource(sourceId)) {
                map.getSource(sourceId).setData({ type: 'FeatureCollection', features: densityFeatures });
            } else {
                map.addSource(sourceId, {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: densityFeatures }
                });

                map.addLayer({
                    id: layerId,
                    type: 'line',
                    source: sourceId,
                    paint: {
                        'line-color': ['get', 'sim_color'],
                        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 18, 12],
                        'line-opacity': 0.9
                    }
                });

                map.on('mousemove', layerId, (e) => {
                    const props = e.features?.[0]?.properties;
                    if (!props) return;
                    const content = _el('div', { style: { padding: '4px', fontSize: '12px' } }, [
                        _el('span', {}, 'Density: ' + props.sim_density + ' p/m\u00B2'),
                        _el('br'),
                        _el('span', {}, 'Crowd: ' + props.sim_crowd + ' people')
                    ]);
                    new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '180px' })
                        .setLngLat(e.lngLat)
                        .setDOMContent(content)
                        .addTo(map);
                });

                map.on('mouseleave', layerId, () => {
                    const popups = document.querySelectorAll('.maplibregl-popup');
                    popups.forEach(p => p.remove());
                });
            }

            // Add radius circle
            const circleSourceId = 'mob-radius-' + event.id;
            if (!map.getSource(circleSourceId)) {
                const circleCoords = [];
                for (let i = 0; i <= 64; i++) {
                    const angle = (i / 64) * 2 * Math.PI;
                    const dLat = (radius / 111320) * Math.cos(angle);
                    const dLng = (radius / (111320 * Math.cos(center[1] * Math.PI / 180))) * Math.sin(angle);
                    circleCoords.push([center[0] + dLng, center[1] + dLat]);
                }
                circleCoords.push(circleCoords[0]);

                map.addSource(circleSourceId, {
                    type: 'geojson',
                    data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleCoords] } }
                });

                map.addLayer({
                    id: 'mob-radius-layer-' + event.id,
                    type: 'line',
                    source: circleSourceId,
                    paint: { 'line-color': '#FF5722', 'line-width': 2, 'line-dasharray': [4, 4], 'line-opacity': 0.7 }
                });
            }
        }

        function clearAll() {
            const map = _getMap();
            _eventMarkers.forEach(m => m.remove());
            _eventMarkers = [];

            _events.forEach(evt => {
                const sourceId = 'mob-sim-' + evt.id;
                const layerId = 'mob-sim-layer-' + evt.id;
                const circleSourceId = 'mob-radius-' + evt.id;
                const circleLayerId = 'mob-radius-layer-' + evt.id;
                if (map?.getLayer(layerId)) map.removeLayer(layerId);
                if (map?.getSource(sourceId)) map.removeSource(sourceId);
                if (map?.getLayer(circleLayerId)) map.removeLayer(circleLayerId);
                if (map?.getSource(circleSourceId)) map.removeSource(circleSourceId);
            });
            _events = [];
            _toast('All events cleared');
        }

        return { startPlacing, clearAll };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 4. FORCE DEPLOYMENT
    // ═══════════════════════════════════════════════════════════════

    const ForceDeployment = (() => {
        let _stationsAdded = false;
        let _isochronesAdded = false;

        function showStations() {
            const map = _getMap();
            if (!map) return;
            if (_stationsAdded) return;

            const features = POLICE_STATIONS.map(s => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
                properties: { name: s.name }
            }));

            map.addSource('mob-police-stations', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features }
            });

            map.addLayer({
                id: 'mob-police-stations-layer',
                type: 'circle',
                source: 'mob-police-stations',
                paint: {
                    'circle-radius': 10,
                    'circle-color': '#1565C0',
                    'circle-stroke-color': '#fff',
                    'circle-stroke-width': 3
                }
            });

            map.addLayer({
                id: 'mob-police-labels',
                type: 'symbol',
                source: 'mob-police-stations',
                layout: {
                    'text-field': ['get', 'name'],
                    'text-size': 11,
                    'text-offset': [0, 1.8],
                    'text-anchor': 'top'
                },
                paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1 }
            });

            map.on('click', 'mob-police-stations-layer', (e) => {
                const props = e.features?.[0]?.properties;
                if (!props) return;
                const content = _el('div', { style: { padding: '6px' } }, [
                    _el('strong', {}, props.name),
                    _el('br'),
                    _el('span', {}, 'Police Station')
                ]);
                new maplibregl.Popup({ maxWidth: '200px' })
                    .setLngLat(e.lngLat)
                    .setDOMContent(content)
                    .addTo(map);
            });

            _stationsAdded = true;
        }

        function showIsochrones() {
            const map = _getMap();
            if (!map) return;
            if (_isochronesAdded) return;

            const speedMps = 30 * 1000 / 3600;
            const times = [5, 10, 15];
            const colors = ['rgba(21,101,192,0.3)', 'rgba(21,101,192,0.2)', 'rgba(21,101,192,0.1)'];
            const features = [];

            POLICE_STATIONS.forEach(station => {
                times.forEach((t, idx) => {
                    const radiusM = speedMps * t * 60;
                    const coords = [];
                    for (let i = 0; i <= 64; i++) {
                        const angle = (i / 64) * 2 * Math.PI;
                        const dLat = (radiusM / 111320) * Math.cos(angle);
                        const dLng = (radiusM / (111320 * Math.cos(station.lat * Math.PI / 180))) * Math.sin(angle);
                        coords.push([station.lng + dLng, station.lat + dLat]);
                    }
                    coords.push(coords[0]);
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: [coords] },
                        properties: { station: station.name, minutes: t, color: colors[idx] }
                    });
                });
            });

            if (map.getSource('mob-isochrones')) return;

            map.addSource('mob-isochrones', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features }
            });

            map.addLayer({
                id: 'mob-isochrones-layer',
                type: 'fill',
                source: 'mob-isochrones',
                paint: {
                    'fill-color': ['get', 'color'],
                    'fill-opacity': 1
                }
            }, 'mob-police-stations-layer');

            map.addLayer({
                id: 'mob-isochrones-outline',
                type: 'line',
                source: 'mob-isochrones',
                paint: { 'line-color': '#1565C0', 'line-width': 1, 'line-dasharray': [3, 3] }
            }, 'mob-police-stations-layer');

            _isochronesAdded = true;
        }

        function calculateForce(crowdSize, situation) {
            const ratio = FORCE_RATIOS[situation] || FORCE_RATIOS.peaceful;
            const force = Math.ceil(crowdSize / ratio);
            const officers = Math.ceil(force * 0.6);
            const reserves = Math.ceil(force * 0.25);
            const commanders = Math.ceil(force * 0.15);
            return { total: force, officers, reserves, commanders, ratio: '1:' + ratio };
        }

        function startCordon() {
            const map = _getMap();
            if (!map) return;
            _drawingCordon = true;
            map.getCanvas().style.cursor = 'crosshair';
            _toast('Click two points on the map to place a cordon');

            let points = [];
            const handler = (e) => {
                points.push([e.lngLat.lng, e.lngLat.lat]);
                if (points.length === 2) {
                    map.off('click', handler);
                    _drawingCordon = false;
                    map.getCanvas().style.cursor = '';
                    _placeCordon(points);
                }
            };
            map.on('click', handler);
        }

        function _placeCordon(points) {
            const map = _getMap();
            if (!map) return;

            const cordonId = 'mob-cordon-' + Date.now();
            _cordons.push(cordonId);

            map.addSource(cordonId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: points },
                    properties: { type: 'cordon' }
                }
            });

            map.addLayer({
                id: cordonId + '-layer',
                type: 'line',
                source: cordonId,
                paint: { 'line-color': '#2196F3', 'line-width': 6, 'line-dasharray': [2, 1], 'line-opacity': 0.9 }
            });

            _toast('Cordon placed');
        }

        return { showStations, showIsochrones, calculateForce, startCordon };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 5. SECTION 144 ZONE TOOL
    // ═══════════════════════════════════════════════════════════════

    const Section144 = (() => {

        function startDrawing(zoneType) {
            const map = _getMap();
            if (!map) return;
            _drawingS144 = true;
            _s144Points = [];
            map.getCanvas().style.cursor = 'crosshair';
            _toast('Click on map to draw ' + zoneType + ' zone. Double-click to finish.');

            const clickHandler = (e) => {
                _s144Points.push([e.lngLat.lng, e.lngLat.lat]);
                _updatePreview();
            };

            const dblClickHandler = (e) => {
                e.preventDefault();
                map.off('click', clickHandler);
                map.off('dblclick', dblClickHandler);
                _drawingS144 = false;
                map.getCanvas().style.cursor = '';
                _removePreview();

                if (_s144Points.length >= 3) {
                    _s144Points.push(_s144Points[0]);
                    _placeZone(zoneType);
                } else {
                    _toast('Need at least 3 points for a zone');
                }
            };

            map.on('click', clickHandler);
            map.on('dblclick', dblClickHandler);
        }

        function _updatePreview() {
            const map = _getMap();
            if (!map || _s144Points.length < 2) return;

            const previewData = {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: _s144Points }
            };

            if (map.getSource('mob-s144-preview')) {
                map.getSource('mob-s144-preview').setData(previewData);
            } else {
                map.addSource('mob-s144-preview', { type: 'geojson', data: previewData });
                map.addLayer({
                    id: 'mob-s144-preview-layer',
                    type: 'line',
                    source: 'mob-s144-preview',
                    paint: { 'line-color': '#FF5722', 'line-width': 2, 'line-dasharray': [3, 2] }
                });
            }
        }

        function _removePreview() {
            const map = _getMap();
            if (!map) return;
            if (map.getLayer('mob-s144-preview-layer')) map.removeLayer('mob-s144-preview-layer');
            if (map.getSource('mob-s144-preview')) map.removeSource('mob-s144-preview');
        }

        function _placeZone(zoneType) {
            const map = _getMap();
            if (!map) return;

            const configs = {
                red: { fill: '#F44336', opacity: 0.3, label: 'Curfew Zone' },
                buffer: { fill: '#FFEB3B', opacity: 0.2, label: 'Restricted Zone' },
                affected: { fill: '#2196F3', opacity: 0.1, label: 'Patrolled Zone' }
            };

            const config = configs[zoneType] || configs.red;
            const zoneId = 'mob-s144-' + zoneType + '-' + Date.now();
            _s144Zones.push(zoneId);

            const polygon = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [_s144Points] }, properties: { zoneType, label: config.label } };

            map.addSource(zoneId, { type: 'geojson', data: polygon });

            map.addLayer({
                id: zoneId + '-fill',
                type: 'fill',
                source: zoneId,
                paint: { 'fill-color': config.fill, 'fill-opacity': config.opacity }
            });

            map.addLayer({
                id: zoneId + '-outline',
                type: 'line',
                source: zoneId,
                paint: { 'line-color': config.fill, 'line-width': 2, 'line-opacity': 0.8 }
            });

            const stats = _computeZoneStats(polygon);
            _toast(config.label + ': ' + stats.area.toFixed(2) + ' km\u00B2, ~' + stats.population + ' affected');
        }

        function _computeZoneStats(polygon) {
            const coords = polygon.geometry.coordinates[0];
            let area = 0;
            for (let i = 0; i < coords.length - 1; i++) {
                const [x1, y1] = coords[i];
                const [x2, y2] = coords[i + 1];
                area += (x2 - x1) * (y2 + y1);
            }
            area = Math.abs(area / 2);
            const areaKm2 = area * 111.32 * 111.32 * Math.cos((BBOX_CITY.south + BBOX_CITY.north) / 2 * Math.PI / 180);

            let roadSegments = 0;
            let buildingCount = 0;

            if (_roadsData?.features) {
                _roadsData.features.forEach(f => {
                    const fCoords = f.geometry?.type === 'LineString' ? f.geometry.coordinates :
                        f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates[0] : [];
                    const mid = _lineMidpoint(fCoords);
                    if (mid && _pointInPolygon(mid, coords)) roadSegments++;
                });
            }

            buildingCount = Math.round(areaKm2 * 500);
            const population = buildingCount * 5;

            return { area: areaKm2, roadSegments, buildingCount, population };
        }

        function clearAll() {
            const map = _getMap();
            _s144Zones.forEach(zoneId => {
                if (map?.getLayer(zoneId + '-fill')) map.removeLayer(zoneId + '-fill');
                if (map?.getLayer(zoneId + '-outline')) map.removeLayer(zoneId + '-outline');
                if (map?.getSource(zoneId)) map.removeSource(zoneId);
            });
            _s144Zones = [];
            _toast('All Section 144 zones cleared');
        }

        return { startDrawing, clearAll };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 7. FLOATING PANEL
    // ═══════════════════════════════════════════════════════════════

    function _createPanel() {
        if (_panel) return;

        _panel = _el('aside', {
            id: 'mob-sim-panel',
            className: 'floating-dialog',
            style: {
                position: 'fixed', top: '60px', right: '60px', width: '320px',
                maxHeight: '80vh', background: '#1a1a2e', border: '1px solid #333',
                borderRadius: '8px', zIndex: '1000', display: 'none', flexDirection: 'column'
            }
        });

        const header = _el('div', {
            style: {
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', borderBottom: '1px solid #333'
            }
        });
        header.appendChild(_el('h3', { style: { margin: '0', fontSize: '14px', color: '#fff' } }, 'Mob Simulation'));
        const closeBtn = _el('button', {
            style: { background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '18px' },
            onClick: () => { _panel.style.display = 'none'; }
        }, '\u00D7');
        header.appendChild(closeBtn);
        _panel.appendChild(header);

        const tabs = _el('div', {
            style: {
                display: 'flex', borderBottom: '1px solid #333', padding: '0 4px',
                overflowX: 'auto', gap: '0'
            }
        });

        const tabDefs = [
            { id: 'roads', label: 'Roads' },
            { id: 'infra', label: 'Infra' },
            { id: 'crowd', label: 'Crowd' },
            { id: 'deploy', label: 'Deploy' },
            { id: 's144', label: 'S.144' }
        ];

        tabDefs.forEach(td => {
            const btn = _el('button', {
                className: 'mob-tab' + (td.id === _activeTab ? ' active' : ''),
                'data-tab': td.id,
                style: {
                    flex: '1', padding: '8px 4px', background: 'none', border: 'none',
                    borderBottom: td.id === _activeTab ? '2px solid #2196F3' : '2px solid transparent',
                    color: td.id === _activeTab ? '#2196F3' : '#888',
                    cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap'
                },
                onClick: () => _switchTab(td.id)
            }, td.label);
            tabs.appendChild(btn);
        });
        _panel.appendChild(tabs);

        const content = _el('div', {
            id: 'mob-panel-content',
            style: { padding: '12px', overflowY: 'auto', flex: '1', maxHeight: 'calc(80vh - 90px)' }
        });
        _panel.appendChild(content);

        document.body.appendChild(_panel);
        _renderTab(_activeTab);
    }

    function _switchTab(tabId) {
        _activeTab = tabId;
        const tabs = _panel.querySelectorAll('.mob-tab');
        tabs.forEach(t => {
            const isActive = t.getAttribute('data-tab') === tabId;
            t.style.borderBottom = isActive ? '2px solid #2196F3' : '2px solid transparent';
            t.style.color = isActive ? '#2196F3' : '#888';
            if (isActive) t.classList.add('active');
            else t.classList.remove('active');
        });
        _renderTab(tabId);
    }

    function _renderTab(tabId) {
        const content = document.getElementById('mob-panel-content');
        if (!content) return;
        content.replaceChildren();

        switch (tabId) {
            case 'roads': _renderRoadsTab(content); break;
            case 'infra': _renderInfraTab(content); break;
            case 'crowd': _renderCrowdTab(content); break;
            case 'deploy': _renderDeployTab(content); break;
            case 's144': _renderS144Tab(content); break;
        }
    }

    function _renderRoadsTab(container) {
        container.appendChild(_el('h4', { style: { color: '#fff', margin: '0 0 8px', fontSize: '13px' } }, 'Road Crowd Risk'));

        const toggleBtn = _el('button', {
            style: _btnStyle('#4CAF50'),
            onClick: () => RoadCapacity.toggle()
        }, RoadCapacity.isVisible() ? 'Hide Roads' : 'Show Roads');
        container.appendChild(toggleBtn);

        const legend = _el('div', { style: { marginTop: '12px' } });
        const risks = [
            { color: '#4CAF50', label: 'Low risk (\u2265 7m width)' },
            { color: '#FFEB3B', label: 'Medium risk (4-7m)' },
            { color: '#FF9800', label: 'High risk (2-4m)' },
            { color: '#F44336', label: 'Critical (< 2m)' }
        ];
        risks.forEach(r => {
            const row = _el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } });
            row.appendChild(_el('div', { style: { width: '16px', height: '4px', background: r.color, borderRadius: '2px' } }));
            row.appendChild(_el('span', { style: { color: '#ccc', fontSize: '12px' } }, r.label));
            legend.appendChild(row);
        });
        container.appendChild(legend);

        if (_roadsData?.features) {
            const stats = _el('div', { style: { marginTop: '12px', padding: '8px', background: '#2a2a3e', borderRadius: '4px' } });
            const total = _roadsData.features.length;
            const critical = _roadsData.features.filter(f => f.properties.crowd_risk === 'critical').length;
            const high = _roadsData.features.filter(f => f.properties.crowd_risk === 'high').length;
            stats.appendChild(_el('p', { style: { color: '#ccc', fontSize: '12px', margin: '2px 0' } }, 'Total segments: ' + total));
            stats.appendChild(_el('p', { style: { color: '#F44336', fontSize: '12px', margin: '2px 0' } }, 'Critical: ' + critical));
            stats.appendChild(_el('p', { style: { color: '#FF9800', fontSize: '12px', margin: '2px 0' } }, 'High risk: ' + high));
            container.appendChild(stats);
        }
    }

    function _renderInfraTab(container) {
        container.appendChild(_el('h4', { style: { color: '#fff', margin: '0 0 8px', fontSize: '13px' } }, 'Sensitive Infrastructure'));

        const toggleBtn = _el('button', {
            style: _btnStyle('#FF6B00'),
            onClick: () => SensitiveInfra.toggle()
        }, SensitiveInfra.isVisible() ? 'Hide Infrastructure' : 'Show Infrastructure');
        container.appendChild(toggleBtn);

        const legend = _el('div', { style: { marginTop: '12px' } });
        const categories = [
            { key: 'hindu_temple', label: 'Hindu Temples' },
            { key: 'mosque', label: 'Mosques' },
            { key: 'jain_temple', label: 'Jain Temples' },
            { key: 'church', label: 'Churches' },
            { key: 'other_worship', label: 'Other Worship' },
            { key: 'market', label: 'Markets' },
            { key: 'school', label: 'Schools' },
            { key: 'hospital', label: 'Hospitals' },
            { key: 'police', label: 'Police' },
            { key: 'fire_station', label: 'Fire Stations' }
        ];

        categories.forEach(cat => {
            const row = _el('div', {
                style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', cursor: 'pointer' },
                onClick: () => {
                    SensitiveInfra.toggleCategory(cat.key);
                    _renderTab('infra');
                }
            });
            const dot = _el('div', {
                style: {
                    width: '12px', height: '12px', borderRadius: '50%',
                    background: INFRA_COLORS[cat.key],
                    opacity: _infraVisible[cat.key] !== false ? '1' : '0.3',
                    border: '1px solid #fff'
                }
            });
            const label = _el('span', {
                style: {
                    color: _infraVisible[cat.key] !== false ? '#ccc' : '#666',
                    fontSize: '12px'
                }
            }, cat.label);
            row.appendChild(dot);
            row.appendChild(label);
            legend.appendChild(row);
        });
        container.appendChild(legend);
    }

    function _renderCrowdTab(container) {
        container.appendChild(_el('h4', { style: { color: '#fff', margin: '0 0 8px', fontSize: '13px' } }, 'Crowd Event Simulator'));

        const placeBtn = _el('button', {
            style: _btnStyle('#FF9800'),
            onClick: () => CrowdSim.startPlacing()
        }, 'Place Event');
        container.appendChild(placeBtn);

        const clearBtn = _el('button', {
            style: { ..._btnStyle('#666'), marginTop: '6px' },
            onClick: () => { CrowdSim.clearAll(); _renderTab('crowd'); }
        }, 'Clear All Events');
        container.appendChild(clearBtn);

        if (_events.length > 0) {
            const eventList = _el('div', { style: { marginTop: '12px' } });
            eventList.appendChild(_el('p', { style: { color: '#ccc', fontSize: '12px', margin: '0 0 6px' } }, 'Active Events:'));
            _events.forEach(evt => {
                const row = _el('div', {
                    style: { padding: '6px 8px', background: '#2a2a3e', borderRadius: '4px', marginBottom: '4px' }
                });
                row.appendChild(_el('span', { style: { color: '#fff', fontSize: '12px' } },
                    evt.eventType.charAt(0).toUpperCase() + evt.eventType.slice(1) +
                    ' \u2014 ' + evt.crowdSize + ' people'));
                eventList.appendChild(row);
            });
            container.appendChild(eventList);
        }

        const fruinLegend = _el('div', { style: { marginTop: '12px' } });
        fruinLegend.appendChild(_el('p', { style: { color: '#aaa', fontSize: '11px', margin: '0 0 6px' } }, 'Fruin Level of Service:'));
        FRUIN_LEVELS.forEach(level => {
            const row = _el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' } });
            row.appendChild(_el('div', { style: { width: '14px', height: '4px', background: level.color, borderRadius: '2px' } }));
            row.appendChild(_el('span', { style: { color: '#999', fontSize: '11px' } }, level.label));
            fruinLegend.appendChild(row);
        });
        container.appendChild(fruinLegend);
    }

    function _renderDeployTab(container) {
        container.appendChild(_el('h4', { style: { color: '#fff', margin: '0 0 8px', fontSize: '13px' } }, 'Force Deployment'));

        const stationsBtn = _el('button', {
            style: _btnStyle('#1565C0'),
            onClick: () => ForceDeployment.showStations()
        }, 'Show Police Stations');
        container.appendChild(stationsBtn);

        const isoBtn = _el('button', {
            style: { ..._btnStyle('#0D47A1'), marginTop: '6px' },
            onClick: () => ForceDeployment.showIsochrones()
        }, 'Show Response Isochrones');
        container.appendChild(isoBtn);

        const cordonBtn = _el('button', {
            style: { ..._btnStyle('#2196F3'), marginTop: '6px' },
            onClick: () => ForceDeployment.startCordon()
        }, 'Place Cordon');
        container.appendChild(cordonBtn);

        // Force calculator
        const calcDiv = _el('div', {
            style: { marginTop: '16px', padding: '10px', background: '#2a2a3e', borderRadius: '6px' }
        });
        calcDiv.appendChild(_el('p', { style: { color: '#ccc', fontSize: '12px', margin: '0 0 8px', fontWeight: 'bold' } }, 'Force Calculator'));

        const crowdInput = _el('input', {
            type: 'number', value: '1000', min: '100', step: '100',
            id: 'mob-force-crowd',
            style: { width: '100%', padding: '6px', background: '#1a1a2e', color: '#fff', border: '1px solid #555', borderRadius: '4px', marginBottom: '8px', boxSizing: 'border-box' }
        });
        calcDiv.appendChild(_el('label', { style: { color: '#aaa', fontSize: '11px' } }, 'Crowd Size'));
        calcDiv.appendChild(crowdInput);

        const sitSelect = _el('select', {
            id: 'mob-force-situation',
            style: { width: '100%', padding: '6px', background: '#1a1a2e', color: '#fff', border: '1px solid #555', borderRadius: '4px', marginBottom: '8px' }
        });
        ['peaceful', 'tense', 'riot'].forEach(s => {
            sitSelect.appendChild(_el('option', { value: s }, s.charAt(0).toUpperCase() + s.slice(1)));
        });
        calcDiv.appendChild(_el('label', { style: { color: '#aaa', fontSize: '11px' } }, 'Situation'));
        calcDiv.appendChild(sitSelect);

        const resultDiv = _el('div', { id: 'mob-force-result', style: { marginTop: '8px' } });

        const calcBtn = _el('button', {
            style: _btnStyle('#4CAF50'),
            onClick: () => {
                const size = parseInt(crowdInput.value, 10) || 1000;
                const sit = sitSelect.value;
                const result = ForceDeployment.calculateForce(size, sit);
                resultDiv.replaceChildren();
                resultDiv.appendChild(_el('p', { style: { color: '#4CAF50', fontSize: '13px', margin: '4px 0', fontWeight: 'bold' } },
                    'Total Force: ' + result.total));
                resultDiv.appendChild(_el('p', { style: { color: '#ccc', fontSize: '11px', margin: '2px 0' } },
                    'Officers: ' + result.officers + ' | Reserves: ' + result.reserves + ' | Commanders: ' + result.commanders));
                resultDiv.appendChild(_el('p', { style: { color: '#888', fontSize: '11px', margin: '2px 0' } },
                    'Ratio: ' + result.ratio));
            }
        }, 'Calculate');
        calcDiv.appendChild(calcBtn);
        calcDiv.appendChild(resultDiv);

        container.appendChild(calcDiv);
    }

    function _renderS144Tab(container) {
        container.appendChild(_el('h4', { style: { color: '#fff', margin: '0 0 8px', fontSize: '13px' } }, 'Section 144 Zones'));

        const zones = [
            { type: 'red', label: 'Curfew Zone (Red)', color: '#F44336' },
            { type: 'buffer', label: 'Restricted Zone (Yellow)', color: '#FFEB3B' },
            { type: 'affected', label: 'Patrolled Zone (Blue)', color: '#2196F3' }
        ];

        zones.forEach(z => {
            const btn = _el('button', {
                style: { ..._btnStyle(z.color), marginBottom: '6px', color: z.type === 'buffer' ? '#000' : '#fff' },
                onClick: () => Section144.startDrawing(z.type)
            }, 'Draw ' + z.label);
            container.appendChild(btn);
        });

        const clearBtn = _el('button', {
            style: { ..._btnStyle('#666'), marginTop: '6px' },
            onClick: () => { Section144.clearAll(); }
        }, 'Clear All Zones');
        container.appendChild(clearBtn);

        const info = _el('div', { style: { marginTop: '12px', padding: '8px', background: '#2a2a3e', borderRadius: '4px' } });
        info.appendChild(_el('p', { style: { color: '#aaa', fontSize: '11px', margin: '0' } },
            'Click on map to draw polygon vertices. Double-click to complete the zone.'));
        if (_s144Zones.length > 0) {
            info.appendChild(_el('p', { style: { color: '#ccc', fontSize: '11px', margin: '6px 0 0' } },
                'Active zones: ' + _s144Zones.length));
        }
        container.appendChild(info);
    }

    // ═══════════════════════════════════════════════════════════════
    // STYLE HELPERS
    // ═══════════════════════════════════════════════════════════════

    function _btnStyle(bg) {
        return {
            width: '100%', padding: '8px 12px', background: bg, color: '#fff',
            border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
            fontWeight: 'bold', display: 'block'
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // 6. TOOLBAR INTEGRATION
    // ═══════════════════════════════════════════════════════════════

    function _initToolbar() {
        const toolbar = document.getElementById('toolbar');
        if (!toolbar) return;

        const buttons = [
            {
                id: 'btn-mob-sim', icon: '\uD83D\uDC65', label: 'Mob', title: 'Mob Simulation',
                action: () => {
                    RoadCapacity.toggle();
                    SensitiveInfra.toggle();
                    _togglePanel();
                }
            },
            {
                id: 'btn-force-deploy', icon: '\uD83D\uDEE1\uFE0F', label: 'Force', title: 'Force Deployment',
                action: () => {
                    _createPanel();
                    _switchTab('deploy');
                    _panel.style.display = 'flex';
                    if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
                    ForceDeployment.showStations();
                }
            }
        ];

        buttons.forEach(btn => {
            if (document.getElementById(btn.id)) return;
            const el = _el('button', { className: 'toolbar-btn', id: btn.id, title: btn.title });
            el.appendChild(_el('span', { className: 'tb-icon' }, btn.icon));
            el.appendChild(_el('span', { className: 'tb-label' }, btn.label));
            el.addEventListener('click', btn.action);
            toolbar.appendChild(el);
        });
    }

    function _togglePanel() {
        _createPanel();
        if (_panel.style.display === 'flex') {
            _panel.style.display = 'none';
        } else {
            _panel.style.display = 'flex';
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════

    function init() {
        const waitForMap = setInterval(() => {
            if (typeof MapModule !== 'undefined' && MapModule.getMap()) {
                clearInterval(waitForMap);
                _map = MapModule.getMap();
                _initToolbar();
                console.log('[MobSimulation] Module initialized');
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        RoadCapacity,
        SensitiveInfra,
        CrowdSim,
        ForceDeployment,
        Section144,
        init
    };
})();
