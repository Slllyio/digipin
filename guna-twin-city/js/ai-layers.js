/**
 * AI Inference Layers — Guna Digital Twin
 * ========================================
 * Visualizes AI/ML pipeline outputs on the MapLibre map:
 *
 *  1. LULC Classification     — land use / land cover polygons
 *  2. NDVI Vegetation         — continuous vegetation index
 *  3. Flood Risk              — flood extent probability
 *  4. Change Detection        — construction / demolition / other
 *  5. Building Intelligence   — 3D fill-extrusion by type
 *  6. Crowd Heatmap           — crowd density circles
 *
 * All data loaded from data/ai_outputs/*.geojson.
 * Graceful fallback when files do not exist.
 *
 * SECURITY: All DOM built via createElement / textContent. No innerHTML.
 */

const AILayers = (() => {
    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    const AI_DATA_BASE = './data/ai_outputs';

    const LAYER_DEFS = {
        lulc: {
            id: 'lulc',
            name: 'LULC Classification',
            file: 'lulc_guna.geojson',
            icon: '\uD83C\uDF0D',
            description: 'Land use / land cover from satellite imagery'
        },
        ndvi: {
            id: 'ndvi',
            name: 'NDVI Vegetation',
            file: 'ndvi_guna.geojson',
            icon: '\uD83C\uDF3F',
            description: 'Normalized Difference Vegetation Index'
        },
        flood: {
            id: 'flood',
            name: 'Flood Risk',
            file: 'flood_extent_guna.geojson',
            icon: '\uD83C\uDF0A',
            description: 'Flood extent and probability zones'
        },
        changes: {
            id: 'changes',
            name: 'Change Detection',
            file: 'changes_guna.geojson',
            icon: '\uD83D\uDD04',
            description: 'Construction, demolition, and land changes'
        },
        buildings_ai: {
            id: 'buildings_ai',
            name: 'Building Intelligence',
            file: 'buildings_ai_guna.geojson',
            icon: '\uD83C\uDFD7',
            description: 'AI-classified building heights and types'
        },
        crowd: {
            id: 'crowd',
            name: 'Crowd Heatmap',
            file: 'crowd_density_guna.geojson',
            icon: '\uD83D\uDC65',
            description: 'Crowd counting and density estimation'
        }
    };

    const LULC_COLORS = {
        water: '#0077BE',
        trees: '#228B22',
        grass: '#90EE90',
        crops: '#FFD700',
        built: '#FF4444',
        bare: '#DEB887'
    };

    const CHANGE_COLORS = {
        construction: '#FF4444',
        demolition: '#4488FF',
        other: '#FFD700'
    };

    let _map = null;
    let _panel = null;
    let _layerState = {};    // { layerId: { visible, available, data } }
    let _hoverPopup = null;
    let _floodAnimFrame = null;

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
                } else if (k.startsWith('on') && typeof v === 'function') {
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
    // DATA AVAILABILITY CHECK
    // ═══════════════════════════════════════════════════════════════

    async function _checkFileExists(file) {
        try {
            const resp = await fetch(`${AI_DATA_BASE}/${file}`, { method: 'HEAD' });
            return resp.ok;
        } catch {
            return false;
        }
    }

    async function _detectAvailableData() {
        const checks = Object.entries(LAYER_DEFS).map(async ([key, def]) => {
            const exists = await _checkFileExists(def.file);
            if (!_layerState[key]) {
                _layerState[key] = { visible: false, available: false, data: null };
            }
            _layerState[key].available = exists;
        });
        await Promise.all(checks);
    }

    async function _loadGeoJSON(file) {
        const resp = await fetch(`${AI_DATA_BASE}/${file}`);
        if (!resp.ok) throw new Error('File not found: ' + file);
        return resp.json();
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER RENDERERS
    // ═══════════════════════════════════════════════════════════════

    // --- 1. LULC Classification ---

    function _addLulcLayer(data) {
        const map = _getMap();
        if (!map) return;

        const srcId = 'ai-lulc-src';
        const layerId = 'ai-lulc-fill';

        if (map.getSource(srcId)) return;

        map.addSource(srcId, { type: 'geojson', data });
        map.addLayer({
            id: layerId,
            type: 'fill',
            source: srcId,
            paint: {
                'fill-color': [
                    'match', ['downcase', ['get', 'class']],
                    'water',  LULC_COLORS.water,
                    'trees',  LULC_COLORS.trees,
                    'grass',  LULC_COLORS.grass,
                    'crops',  LULC_COLORS.crops,
                    'built',  LULC_COLORS.built,
                    'bare',   LULC_COLORS.bare,
                    '#888888'
                ],
                'fill-opacity': 0.55,
                'fill-outline-color': '#ffffff'
            }
        });
        map.addLayer({
            id: layerId + '-outline',
            type: 'line',
            source: srcId,
            paint: {
                'line-color': '#ffffff',
                'line-width': 0.5,
                'line-opacity': 0.4
            }
        });

        _setupHover(layerId, f => {
            const p = f.properties || {};
            const cls = p.class || 'Unknown';
            const area = p.area_sqm ? (parseFloat(p.area_sqm) / 10000).toFixed(2) + ' ha' : '';
            return 'LULC: ' + cls + (area ? ' | ' + area : '');
        });
    }

    function _removeLulcLayer() {
        const map = _getMap();
        if (!map) return;
        ['ai-lulc-fill-outline', 'ai-lulc-fill'].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource('ai-lulc-src')) map.removeSource('ai-lulc-src');
    }

    // --- 2. NDVI Vegetation ---

    function _addNdviLayer(data) {
        const map = _getMap();
        if (!map) return;

        const srcId = 'ai-ndvi-src';
        const layerId = 'ai-ndvi-fill';

        if (map.getSource(srcId)) return;

        map.addSource(srcId, { type: 'geojson', data });
        map.addLayer({
            id: layerId,
            type: 'fill',
            source: srcId,
            paint: {
                'fill-color': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'ndvi'], 0.3],
                    0.0, '#FF0000',
                    0.15, '#FF8800',
                    0.3, '#FFFF00',
                    0.5, '#88CC00',
                    0.7, '#228B22',
                    1.0, '#004400'
                ],
                'fill-opacity': 0.6
            }
        });

        _setupHover(layerId, f => {
            const ndvi = parseFloat(f.properties?.ndvi || 0).toFixed(3);
            const label = parseFloat(ndvi) < 0.2 ? 'Bare/Built' :
                          parseFloat(ndvi) < 0.4 ? 'Sparse vegetation' :
                          parseFloat(ndvi) < 0.6 ? 'Moderate vegetation' : 'Dense vegetation';
            return 'NDVI: ' + ndvi + ' (' + label + ')';
        });
    }

    function _removeNdviLayer() {
        const map = _getMap();
        if (!map) return;
        if (map.getLayer('ai-ndvi-fill')) map.removeLayer('ai-ndvi-fill');
        if (map.getSource('ai-ndvi-src')) map.removeSource('ai-ndvi-src');
    }

    // --- 3. Flood Risk ---

    function _addFloodLayer(data) {
        const map = _getMap();
        if (!map) return;

        const srcId = 'ai-flood-src';
        const layerId = 'ai-flood-fill';

        if (map.getSource(srcId)) return;

        map.addSource(srcId, { type: 'geojson', data });
        map.addLayer({
            id: layerId,
            type: 'fill',
            source: srcId,
            paint: {
                'fill-color': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'probability'], 0.5],
                    0.0, '#87CEEB',
                    0.3, '#4169E1',
                    0.6, '#0000CD',
                    1.0, '#00008B'
                ],
                'fill-opacity': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'probability'], 0.5],
                    0.0, 0.2,
                    1.0, 0.7
                ]
            }
        });
        map.addLayer({
            id: layerId + '-outline',
            type: 'line',
            source: srcId,
            paint: {
                'line-color': '#1E90FF',
                'line-width': 1.5,
                'line-opacity': 0.8
            }
        });

        _startFloodPulse();

        _setupHover(layerId, f => {
            const prob = (parseFloat(f.properties?.probability || 0) * 100).toFixed(0);
            const depth = f.properties?.depth_m ? parseFloat(f.properties.depth_m).toFixed(1) + 'm' : '';
            return 'Flood risk: ' + prob + '%' + (depth ? ' | depth: ' + depth : '');
        });
    }

    function _startFloodPulse() {
        let phase = 0;
        const map = _getMap();
        if (!map) return;

        function animate() {
            phase = (phase + 0.02) % (2 * Math.PI);
            const opacity = 0.35 + 0.2 * Math.sin(phase);
            if (map.getLayer('ai-flood-fill')) {
                map.setPaintProperty('ai-flood-fill', 'fill-opacity', [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'probability'], 0.5],
                    0.0, opacity * 0.5,
                    1.0, opacity * 1.5
                ]);
            }
            _floodAnimFrame = requestAnimationFrame(animate);
        }
        animate();
    }

    function _stopFloodPulse() {
        if (_floodAnimFrame) {
            cancelAnimationFrame(_floodAnimFrame);
            _floodAnimFrame = null;
        }
    }

    function _removeFloodLayer() {
        _stopFloodPulse();
        const map = _getMap();
        if (!map) return;
        ['ai-flood-fill-outline', 'ai-flood-fill'].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource('ai-flood-src')) map.removeSource('ai-flood-src');
    }

    // --- 4. Change Detection ---

    function _addChangesLayer(data) {
        const map = _getMap();
        if (!map) return;

        const srcId = 'ai-changes-src';
        const layerId = 'ai-changes-fill';

        if (map.getSource(srcId)) return;

        map.addSource(srcId, { type: 'geojson', data });
        map.addLayer({
            id: layerId,
            type: 'fill',
            source: srcId,
            paint: {
                'fill-color': [
                    'match', ['downcase', ['get', 'change_type']],
                    'construction', CHANGE_COLORS.construction,
                    'new_construction', CHANGE_COLORS.construction,
                    'demolition', CHANGE_COLORS.demolition,
                    CHANGE_COLORS.other
                ],
                'fill-opacity': 0.6,
                'fill-outline-color': '#ffffff'
            }
        });
        map.addLayer({
            id: layerId + '-outline',
            type: 'line',
            source: srcId,
            paint: {
                'line-color': '#ffffff',
                'line-width': 1,
                'line-opacity': 0.6
            }
        });

        _setupHover(layerId, f => {
            const p = f.properties || {};
            const type = p.change_type || 'unknown';
            const dateBefore = p.date_before || '';
            const dateAfter = p.date_after || '';
            const parts = ['Change: ' + type];
            if (dateBefore && dateAfter) parts.push(dateBefore + ' -> ' + dateAfter);
            if (p.area_sqm) parts.push(parseFloat(p.area_sqm).toFixed(0) + ' sqm');
            return parts.join(' | ');
        });
    }

    function _removeChangesLayer() {
        const map = _getMap();
        if (!map) return;
        ['ai-changes-fill-outline', 'ai-changes-fill'].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource('ai-changes-src')) map.removeSource('ai-changes-src');
    }

    // --- 5. Building Intelligence ---

    function _addBuildingsAiLayer(data) {
        const map = _getMap();
        if (!map) return;

        const srcId = 'ai-buildings-src';
        const layerId = 'ai-buildings-extrusion';

        if (map.getSource(srcId)) return;

        map.addSource(srcId, { type: 'geojson', data });
        map.addLayer({
            id: layerId,
            type: 'fill-extrusion',
            source: srcId,
            paint: {
                'fill-extrusion-color': [
                    'match', ['downcase', ['coalesce', ['get', 'building_type'], 'unknown']],
                    'residential',  '#818cf8',
                    'commercial',   '#f59e0b',
                    'industrial',   '#6b7280',
                    'institutional','#22c55e',
                    'mixed',        '#ec4899',
                    '#94a3b8'
                ],
                'fill-extrusion-height': [
                    '*',
                    ['to-number', ['coalesce', ['get', 'height'], ['get', 'floors']], 3],
                    3
                ],
                'fill-extrusion-base': 0,
                'fill-extrusion-opacity': 0.75
            }
        });

        _setupHover(layerId, f => {
            const p = f.properties || {};
            const parts = [];
            if (p.building_type) parts.push(p.building_type);
            if (p.height) parts.push('H: ' + parseFloat(p.height).toFixed(1) + 'm');
            else if (p.floors) parts.push(p.floors + ' floors');
            if (p.condition) parts.push('Condition: ' + p.condition);
            return parts.join(' | ') || 'Building';
        });
    }

    function _removeBuildingsAiLayer() {
        const map = _getMap();
        if (!map) return;
        if (map.getLayer('ai-buildings-extrusion')) map.removeLayer('ai-buildings-extrusion');
        if (map.getSource('ai-buildings-src')) map.removeSource('ai-buildings-src');
    }

    // --- 6. Crowd Heatmap ---

    function _addCrowdLayer(data) {
        const map = _getMap();
        if (!map) return;

        const srcId = 'ai-crowd-src';
        const layerId = 'ai-crowd-circles';

        if (map.getSource(srcId)) return;

        map.addSource(srcId, { type: 'geojson', data });
        map.addLayer({
            id: layerId,
            type: 'circle',
            source: srcId,
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'density'], 10],
                    0, 4,
                    50, 12,
                    200, 24,
                    500, 40
                ],
                'circle-color': [
                    'interpolate', ['linear'],
                    ['to-number', ['get', 'density'], 10],
                    0,    '#22c55e',
                    50,   '#eab308',
                    150,  '#f97316',
                    300,  '#ef4444',
                    500,  '#7f1d1d'
                ],
                'circle-opacity': 0.7,
                'circle-stroke-width': 1,
                'circle-stroke-color': '#ffffff'
            }
        });

        _setupHover(layerId, f => {
            const p = f.properties || {};
            const density = p.density || 0;
            const label = density < 50 ? 'Safe' :
                          density < 150 ? 'Moderate' :
                          density < 300 ? 'Crowded' : 'Dangerous';
            const parts = ['Density: ' + density + ' ppl/cell'];
            parts.push('Status: ' + label);
            if (p.location) parts.push(p.location);
            return parts.join(' | ');
        });
    }

    function _removeCrowdLayer() {
        const map = _getMap();
        if (!map) return;
        if (map.getLayer('ai-crowd-circles')) map.removeLayer('ai-crowd-circles');
        if (map.getSource('ai-crowd-src')) map.removeSource('ai-crowd-src');
    }

    // ═══════════════════════════════════════════════════════════════
    // HOVER TOOLTIP
    // ═══════════════════════════════════════════════════════════════

    function _setupHover(layerId, formatFn) {
        const map = _getMap();
        if (!map) return;

        map.on('mouseenter', layerId, () => {
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = '';
            if (_hoverPopup) {
                _hoverPopup.remove();
                _hoverPopup = null;
            }
        });
        map.on('mousemove', layerId, e => {
            if (!e.features || e.features.length === 0) return;
            const text = formatFn(e.features[0]);
            if (!text) return;

            if (_hoverPopup) _hoverPopup.remove();
            _hoverPopup = new maplibregl.Popup({
                closeButton: false,
                closeOnClick: false,
                className: 'ai-layer-popup'
            })
                .setLngLat(e.lngLat)
                .setText(text)
                .addTo(map);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER TOGGLE DISPATCH
    // ═══════════════════════════════════════════════════════════════

    const LAYER_ACTIONS = {
        lulc:         { add: _addLulcLayer,        remove: _removeLulcLayer },
        ndvi:         { add: _addNdviLayer,        remove: _removeNdviLayer },
        flood:        { add: _addFloodLayer,       remove: _removeFloodLayer },
        changes:      { add: _addChangesLayer,     remove: _removeChangesLayer },
        buildings_ai: { add: _addBuildingsAiLayer, remove: _removeBuildingsAiLayer },
        crowd:        { add: _addCrowdLayer,       remove: _removeCrowdLayer }
    };

    async function _toggleLayer(key) {
        const state = _layerState[key];
        if (!state) return;

        if (state.visible) {
            LAYER_ACTIONS[key].remove();
            state.visible = false;
            _updatePanelRow(key);
            return;
        }

        if (!state.available) {
            _toast('Data not available for ' + LAYER_DEFS[key].name + '. Run the AI pipeline first.');
            return;
        }

        try {
            if (!state.data) {
                _toast('Loading ' + LAYER_DEFS[key].name + '...');
                state.data = await _loadGeoJSON(LAYER_DEFS[key].file);
            }
            LAYER_ACTIONS[key].add(state.data);
            state.visible = true;
            _updatePanelRow(key);
            _toast(LAYER_DEFS[key].name + ' layer added');
        } catch (err) {
            _toast('Error loading ' + LAYER_DEFS[key].name + ': ' + err.message);
            console.error('[AILayers]', err);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // FLOATING PANEL
    // ═══════════════════════════════════════════════════════════════

    function _createPanel() {
        if (_panel) return;

        _panel = _el('aside', {
            id: 'ai-layers-panel',
            className: 'floating-dialog',
            style: {
                position: 'fixed', top: '60px', right: '60px', width: '320px',
                maxHeight: '80vh', background: '#1a1a2e', border: '1px solid #333',
                borderRadius: '8px', zIndex: '1000', display: 'none', flexDirection: 'column'
            }
        });

        // Header
        const header = _el('div', {
            style: {
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', borderBottom: '1px solid #333'
            }
        });
        header.appendChild(_el('h3', {
            style: { margin: '0', fontSize: '14px', color: '#fff' }
        }, 'AI Inference Layers'));
        const closeBtn = _el('button', {
            style: { background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '18px' },
            onClick: () => { _panel.style.display = 'none'; }
        }, '\u00D7');
        header.appendChild(closeBtn);
        _panel.appendChild(header);

        // Layer list
        const listContainer = _el('div', {
            id: 'ai-layers-list',
            style: { padding: '8px', overflowY: 'auto', flex: '1', maxHeight: 'calc(80vh - 60px)' }
        });

        Object.entries(LAYER_DEFS).forEach(([key, def]) => {
            const state = _layerState[key] || { visible: false, available: false, data: null };
            _layerState[key] = state;

            const row = _el('div', {
                id: 'ai-row-' + key,
                style: {
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 6px', borderBottom: '1px solid #222', cursor: 'pointer'
                },
                onClick: () => _toggleLayer(key)
            });

            // Status indicator
            const dot = _el('span', {
                id: 'ai-dot-' + key,
                style: {
                    width: '10px', height: '10px', borderRadius: '50%', flexShrink: '0',
                    background: state.visible ? '#22c55e' : (state.available ? '#555' : '#333'),
                    border: state.available ? '1px solid #666' : '1px solid #444'
                }
            });
            row.appendChild(dot);

            // Icon
            row.appendChild(_el('span', {
                style: { fontSize: '16px', flexShrink: '0' }
            }, def.icon));

            // Text block
            const textBlock = _el('div', { style: { flex: '1', minWidth: '0' } });
            textBlock.appendChild(_el('div', {
                style: {
                    fontSize: '13px', fontWeight: 'bold',
                    color: state.available ? '#e0e0e0' : '#666'
                }
            }, def.name));
            const descText = state.available
                ? def.description
                : 'Run pipeline first';
            textBlock.appendChild(_el('div', {
                id: 'ai-desc-' + key,
                style: { fontSize: '11px', color: state.available ? '#888' : '#555' }
            }, descText));
            row.appendChild(textBlock);

            // Toggle label
            const toggleLabel = _el('span', {
                id: 'ai-toggle-' + key,
                style: {
                    fontSize: '11px', fontWeight: 'bold', flexShrink: '0',
                    color: state.visible ? '#22c55e' : (state.available ? '#666' : '#444')
                }
            }, state.visible ? 'ON' : (state.available ? 'OFF' : '--'));
            row.appendChild(toggleLabel);

            listContainer.appendChild(row);
        });

        _panel.appendChild(listContainer);

        // Legend area
        const legendArea = _el('div', {
            id: 'ai-legend-area',
            style: { padding: '8px', borderTop: '1px solid #333', maxHeight: '150px', overflowY: 'auto' }
        });
        _panel.appendChild(legendArea);

        // Refresh button
        const refreshRow = _el('div', {
            style: { padding: '8px', borderTop: '1px solid #333', textAlign: 'center' }
        });
        const refreshBtn = _el('button', {
            style: {
                width: '100%', padding: '6px 12px', background: '#2563eb', color: '#fff',
                border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px'
            },
            onClick: async () => {
                _toast('Scanning for AI outputs...');
                await _detectAvailableData();
                _rebuildPanelRows();
                const available = Object.values(_layerState).filter(s => s.available).length;
                _toast(available + ' of ' + Object.keys(LAYER_DEFS).length + ' AI outputs found');
            }
        }, 'Refresh Available Data');
        refreshRow.appendChild(refreshBtn);
        _panel.appendChild(refreshRow);

        document.body.appendChild(_panel);
    }

    function _updatePanelRow(key) {
        const state = _layerState[key];
        if (!state) return;

        const dot = document.getElementById('ai-dot-' + key);
        if (dot) {
            dot.style.background = state.visible ? '#22c55e' : (state.available ? '#555' : '#333');
            dot.style.border = state.available ? '1px solid #666' : '1px solid #444';
        }

        const toggle = document.getElementById('ai-toggle-' + key);
        if (toggle) {
            toggle.textContent = state.visible ? 'ON' : (state.available ? 'OFF' : '--');
            toggle.style.color = state.visible ? '#22c55e' : (state.available ? '#666' : '#444');
        }

        const desc = document.getElementById('ai-desc-' + key);
        if (desc) {
            const def = LAYER_DEFS[key];
            desc.textContent = state.available ? def.description : 'Run pipeline first';
            desc.style.color = state.available ? '#888' : '#555';
        }

        _updateLegend();
    }

    function _rebuildPanelRows() {
        Object.keys(LAYER_DEFS).forEach(key => _updatePanelRow(key));
    }

    // ═══════════════════════════════════════════════════════════════
    // LEGEND
    // ═══════════════════════════════════════════════════════════════

    function _updateLegend() {
        const area = document.getElementById('ai-legend-area');
        if (!area) return;

        // Clear
        while (area.firstChild) area.removeChild(area.firstChild);

        const visibleLayers = Object.entries(_layerState).filter(([, s]) => s.visible);
        if (visibleLayers.length === 0) {
            area.appendChild(_el('div', {
                style: { fontSize: '11px', color: '#555', textAlign: 'center', padding: '4px' }
            }, 'Toggle a layer to see its legend'));
            return;
        }

        visibleLayers.forEach(([key]) => {
            if (key === 'lulc') _buildLulcLegend(area);
            if (key === 'ndvi') _buildNdviLegend(area);
            if (key === 'flood') _buildFloodLegend(area);
            if (key === 'changes') _buildChangesLegend(area);
            if (key === 'buildings_ai') _buildBuildingsLegend(area);
            if (key === 'crowd') _buildCrowdLegend(area);
        });
    }

    function _legendTitle(parent, text) {
        parent.appendChild(_el('div', {
            style: { fontSize: '11px', fontWeight: 'bold', color: '#aaa', marginBottom: '4px', marginTop: '4px' }
        }, text));
    }

    function _legendItem(parent, color, label) {
        const row = _el('div', {
            style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }
        });
        row.appendChild(_el('span', {
            style: {
                width: '12px', height: '12px', borderRadius: '2px',
                background: color, flexShrink: '0', display: 'inline-block'
            }
        }));
        row.appendChild(_el('span', { style: { fontSize: '11px', color: '#ccc' } }, label));
        parent.appendChild(row);
    }

    function _buildLulcLegend(area) {
        _legendTitle(area, 'LULC Classes');
        Object.entries(LULC_COLORS).forEach(([cls, color]) => {
            _legendItem(area, color, cls.charAt(0).toUpperCase() + cls.slice(1));
        });
    }

    function _buildNdviLegend(area) {
        _legendTitle(area, 'NDVI Scale');
        const stops = [
            ['#FF0000', '0.0 - Bare'],
            ['#FFFF00', '0.3 - Sparse'],
            ['#88CC00', '0.5 - Moderate'],
            ['#228B22', '0.7+ - Dense']
        ];
        stops.forEach(([c, l]) => _legendItem(area, c, l));
    }

    function _buildFloodLegend(area) {
        _legendTitle(area, 'Flood Probability');
        const stops = [
            ['#87CEEB', 'Low (0-30%)'],
            ['#4169E1', 'Medium (30-60%)'],
            ['#0000CD', 'High (60-100%)']
        ];
        stops.forEach(([c, l]) => _legendItem(area, c, l));
    }

    function _buildChangesLegend(area) {
        _legendTitle(area, 'Change Types');
        Object.entries(CHANGE_COLORS).forEach(([type, color]) => {
            _legendItem(area, color, type.charAt(0).toUpperCase() + type.slice(1));
        });
    }

    function _buildBuildingsLegend(area) {
        _legendTitle(area, 'Building Types');
        const types = [
            ['#818cf8', 'Residential'],
            ['#f59e0b', 'Commercial'],
            ['#6b7280', 'Industrial'],
            ['#22c55e', 'Institutional'],
            ['#ec4899', 'Mixed']
        ];
        types.forEach(([c, l]) => _legendItem(area, c, l));
    }

    function _buildCrowdLegend(area) {
        _legendTitle(area, 'Crowd Density');
        const stops = [
            ['#22c55e', 'Safe (< 50)'],
            ['#eab308', 'Moderate (50-150)'],
            ['#f97316', 'Crowded (150-300)'],
            ['#ef4444', 'Dangerous (300+)']
        ];
        stops.forEach(([c, l]) => _legendItem(area, c, l));
    }

    // ═══════════════════════════════════════════════════════════════
    // TOOLBAR INTEGRATION
    // ═══════════════════════════════════════════════════════════════

    function _initToolbar() {
        const toolbar = document.getElementById('toolbar');
        if (!toolbar) return;
        if (document.getElementById('btn-ai-layers')) return;

        const el = _el('button', {
            className: 'toolbar-btn', id: 'btn-ai-layers', title: 'AI Inference Layers'
        });
        el.appendChild(_el('span', { className: 'tb-icon' }, '\uD83E\uDDE0'));
        el.appendChild(_el('span', { className: 'tb-label' }, 'AI'));
        el.addEventListener('click', _togglePanel);
        toolbar.appendChild(el);
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
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════

    function toggleLayer(key) {
        return _toggleLayer(key);
    }

    function isLayerVisible(key) {
        return _layerState[key]?.visible || false;
    }

    function getAvailableLayers() {
        return Object.entries(_layerState)
            .filter(([, s]) => s.available)
            .map(([key]) => key);
    }

    function hideAll() {
        Object.entries(_layerState).forEach(([key, state]) => {
            if (state.visible) {
                LAYER_ACTIONS[key].remove();
                state.visible = false;
            }
        });
        _rebuildPanelRows();
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
                _detectAvailableData().then(() => {
                    const available = Object.values(_layerState).filter(s => s.available).length;
                    if (available > 0) {
                        console.log('[AILayers] ' + available + ' AI output(s) detected');
                    } else {
                        console.log('[AILayers] No AI outputs found in data/ai_outputs/. Run pipeline to generate.');
                    }
                });
                console.log('[AILayers] Module initialized');
            }
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        toggleLayer,
        isLayerVisible,
        getAvailableLayers,
        hideAll,
        init
    };
})();
