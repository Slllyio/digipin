/**
 * Strategic Digital Twin Module — Guna City
 * ==========================================
 * Implements 9 features from "Digital Twins for Strategic Planning" paper:
 *
 *  1. Ward-Level Dashboard with KPI aggregation
 *  2. Carbon & Energy Footprint estimation
 *  3. Active Mobility / Pedestrian-Bicycle network analysis
 *  4. Citizen Feedback / Issue Reporting layer
 *  5. Flood Early Warning with forecast integration
 *  6. Scenario Simulation Engine (what-if planning)
 *  7. Emergency Response Simulation
 *  8. Urban Heat Island analysis
 *  9. Generative Digital Twin — AI data gap filling
 *
 * All features use existing open data (OSM, Overture, SRTM, Open-Meteo).
 * No backend required — runs entirely client-side.
 *
 * SECURITY NOTE: All user-facing content uses textContent or escaped strings.
 * Data from external APIs is sanitized via the esc() helper before rendering.
 */

const StrategicTwin = (() => {
    const GUNA = { lat: 24.6354, lon: 77.3126 };
    const DATA_BASE = './data';
    let _map = null;

    /** Escape HTML to prevent XSS from external API data */
    function esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

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
        if (children) {
            if (typeof children === 'string') el.textContent = children;
            else if (Array.isArray(children)) children.forEach(c => { if (c) el.appendChild(c); });
            else el.appendChild(children);
        }
        return el;
    }

    /** Set innerHTML safely — only used with fully escaped/hardcoded content */
    function _setEscapedHTML(el, html) {
        // All values in html are pre-escaped via esc() or are hardcoded literals
        el.innerHTML = html;
    }

    // ═══════════════════════════════════════════════════════════════
    // 1. WARD-LEVEL DASHBOARD
    // ═══════════════════════════════════════════════════════════════

    const WardDashboard = (() => {
        let _panel = null;
        let _wardScores = null;
        const SAMPLE_GRID = 4;

        async function open() {
            _map = MapModule.getMap();
            if (!_panel) _createPanel();
            _panel.classList.add('open');
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
            _renderLoading();
            await _computeWardKPIs();
        }

        function _createPanel() {
            _panel = _el('aside', { id: 'ward-dashboard', className: 'floating-dialog', 'aria-label': 'Ward Dashboard' });
            const header = _el('div', { className: 'panel-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' } });
            header.appendChild(_el('h3', { style: { margin: '0', fontSize: '15px' } }, 'Ward KPI Dashboard'));
            const closeBtn = _el('button', { className: 'close-btn', 'aria-label': 'Close' });
            closeBtn.textContent = '\u00D7';
            closeBtn.addEventListener('click', () => _panel.classList.remove('open'));
            header.appendChild(closeBtn);
            _panel.appendChild(header);
            _panel.appendChild(_el('div', { id: 'ward-dash-content', className: 'panel-content', style: { padding: '8px 12px', maxHeight: '70vh', overflowY: 'auto' } }));
            document.body.appendChild(_panel);
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
        }

        function _renderLoading() {
            const c = _panel.querySelector('#ward-dash-content');
            c.replaceChildren();
            const wrapper = _el('div', { style: { textAlign: 'center', padding: '40px' } });
            wrapper.appendChild(_el('div', { className: 'spinner' }));
            wrapper.appendChild(_el('p', {}, 'Aggregating ward-level KPIs...'));
            c.appendChild(wrapper);
        }

        async function _computeWardKPIs() {
            const c = _panel.querySelector('#ward-dash-content');
            try {
                const resp = await fetch(`${DATA_BASE}/vectors/osm_admin_boundaries_guna.geojson`);
                if (!resp.ok) throw new Error('Ward boundaries not found');
                const wards = await resp.json();

                if (!wards.features || wards.features.length === 0) {
                    c.replaceChildren(_el('p', { style: { padding: '20px', color: '#999' } }, 'No ward boundaries available.'));
                    return;
                }

                const kpiKeys = ['livability', 'safety', 'green', 'connectivity', 'healthcare_access', 'walkability', 'commercial', 'flood_risk'];
                const results = [];

                for (const ward of wards.features) {
                    const name = ward.properties?.name || 'Ward ' + (ward.properties?.admin_level || '?');
                    const bbox = _getBBox(ward.geometry);
                    if (!bbox) continue;

                    const latStep = (bbox.north - bbox.south) / SAMPLE_GRID;
                    const lngStep = (bbox.east - bbox.west) / SAMPLE_GRID;
                    const scores = {};
                    kpiKeys.forEach(k => scores[k] = []);
                    let sampled = 0;

                    const samplePoints = [];
                    for (let i = 1; i < SAMPLE_GRID; i++) {
                        for (let j = 1; j < SAMPLE_GRID; j++) {
                            samplePoints.push({ lat: bbox.south + latStep * i, lng: bbox.west + lngStep * j });
                        }
                    }

                    // Prefer the precomputed score tiles (instant, cached shards) over
                    // live DataFetcher.fetchAllFeatures — sampling 4 live points across
                    // every ward meant ~hundreds of external-API-bound calls and a
                    // multi-minute hang. Fall back to the live path only when no tiles.
                    const usePrecomp = typeof PrecomputedScores !== 'undefined'
                        && PrecomputedScores.isEnabled && PrecomputedScores.isEnabled();
                    const selected = usePrecomp ? samplePoints : samplePoints.slice(0, 4);
                    const fetches = await Promise.allSettled(
                        selected.map(pt => usePrecomp
                            ? PrecomputedScores.lookup(pt.lat, pt.lng)
                            : DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400))
                    );

                    fetches.forEach(r => {
                        if (r.status !== 'fulfilled' || !r.value) return;
                        const s = r.value.scores || {};
                        kpiKeys.forEach(k => { if (s[k]?.value != null) scores[k].push(s[k].value); });
                        sampled++;
                    });

                    const avgScores = {};
                    kpiKeys.forEach(k => {
                        const vals = scores[k];
                        avgScores[k] = vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
                    });

                    results.push({ name, avgScores, sampled, bbox });
                }

                _wardScores = results;
                _renderDashboard(results, kpiKeys);
            } catch (err) {
                c.replaceChildren(_el('p', { style: { padding: '20px', color: '#ef4444' } }, 'Error: ' + err.message));
            }
        }

        function _renderDashboard(results, kpiKeys) {
            const c = _panel.querySelector('#ward-dash-content');
            if (results.length === 0) {
                c.replaceChildren(_el('p', { style: { padding: '20px', color: '#999' } }, 'No wards could be analyzed.'));
                return;
            }

            results.sort((a, b) => (b.avgScores.livability || 0) - (a.avgScores.livability || 0));

            const labels = {
                livability: 'Livability', safety: 'Safety', green: 'Green',
                connectivity: 'Transit', healthcare_access: 'Health',
                walkability: 'Walk', commercial: 'Biz', flood_risk: 'Flood'
            };

            // Build table using DOM methods
            c.replaceChildren();
            c.appendChild(_el('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } },
                'Ranked by Livability score (4 sample points per ward)'));

            const table = _el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } });
            const thead = _el('thead');
            const headerRow = _el('tr', { style: { borderBottom: '1px solid #333' } });
            headerRow.appendChild(_el('th', { style: { textAlign: 'left', padding: '6px 4px' } }, '#'));
            headerRow.appendChild(_el('th', { style: { textAlign: 'left', padding: '6px 4px' } }, 'Ward'));
            kpiKeys.forEach(k => {
                headerRow.appendChild(_el('th', { style: { textAlign: 'center', padding: '6px 2px', fontSize: '10px' } }, labels[k]));
            });
            thead.appendChild(headerRow);
            table.appendChild(thead);

            const tbody = _el('tbody');
            results.forEach((r, idx) => {
                const row = _el('tr', { style: { borderBottom: '1px solid #222', cursor: 'pointer' } });
                row.addEventListener('click', () => {
                    if (r.bbox) {
                        _map.fitBounds([[r.bbox.west, r.bbox.south], [r.bbox.east, r.bbox.north]], { padding: 40, duration: 1500 });
                    }
                });
                row.appendChild(_el('td', { style: { padding: '4px', color: '#666' } }, String(idx + 1)));
                const nameCell = _el('td', { style: { padding: '4px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.name });
                nameCell.textContent = r.name;
                row.appendChild(nameCell);
                kpiKeys.forEach(k => {
                    const v = r.avgScores[k];
                    const color = v == null ? '#444' : v >= 70 ? '#22c55e' : v >= 40 ? '#eab308' : v >= 20 ? '#f97316' : '#ef4444';
                    row.appendChild(_el('td', { style: { textAlign: 'center', padding: '4px', color, fontWeight: '600' } }, v != null ? String(v) : '-'));
                });
                tbody.appendChild(row);
            });
            table.appendChild(tbody);
            c.appendChild(table);

            // Summary
            const best = results[0];
            const worst = results[results.length - 1];
            const summary = _el('div', { style: { marginTop: '12px', padding: '8px', background: 'rgba(0,229,255,0.05)', borderRadius: '8px', fontSize: '12px' } });
            summary.appendChild(_el('div', { style: { color: '#00e5ff', fontWeight: '600', marginBottom: '4px' } }, 'Summary'));
            summary.appendChild(_el('div', {}, 'Best: ' + (best?.name || '-') + ' (Livability: ' + (best?.avgScores.livability || '-') + ')'));
            summary.appendChild(_el('div', {}, 'Needs attention: ' + (worst?.name || '-') + ' (Livability: ' + (worst?.avgScores.livability || '-') + ')'));
            summary.appendChild(_el('div', { style: { marginTop: '4px', color: '#888' } },
                results.length + ' wards analyzed, ' + results.reduce((s, r) => s + r.sampled, 0) + ' total sample points'));
            c.appendChild(summary);
        }

        function _getBBox(geometry) {
            if (!geometry) return null;
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            const processCoords = coords => {
                if (typeof coords[0] === 'number') {
                    minLon = Math.min(minLon, coords[0]); maxLon = Math.max(maxLon, coords[0]);
                    minLat = Math.min(minLat, coords[1]); maxLat = Math.max(maxLat, coords[1]);
                } else { coords.forEach(processCoords); }
            };
            processCoords(geometry.coordinates);
            return { south: minLat, north: maxLat, west: minLon, east: maxLon };
        }

        function close() { if (_panel) _panel.classList.remove('open'); }
        function getScores() { return _wardScores; }
        return { open, close, getScores };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 2. CARBON & ENERGY FOOTPRINT SCORES
    // ═══════════════════════════════════════════════════════════════

    const CarbonFootprint = (() => {
        function computeScore(features, scores) {
            const f = features || {};
            const s = scores || {};
            const buildingFactor = Math.min((f.total_buildings || 0) / 50, 1) * 30;
            const roadFactor = Math.min((f.road_network || 0) / 20, 1) * 25;
            const commercialFactor = ((s.commercial?.value || 0) / 100) * 20;
            const greenOffset = ((s.green?.value || 0) / 100) * 25;
            const industrialFactor = Math.min((f.industrial_areas || 0) / 3, 1) * 15;
            return Math.max(0, Math.min(100, Math.round(buildingFactor + roadFactor + commercialFactor + industrialFactor - greenOffset)));
        }

        function computeEfficiency(features, scores) {
            const s = scores || {};
            const f = features || {};
            const solarFactor = 25;
            const buildingFactor = Math.min((f.total_buildings || 0) / 30, 1) * 25;
            const greenFactor = (Math.max(0, 100 - (s.green?.value || 0)) / 100) * 25;
            const commercialFactor = ((s.commercial?.value || 0) / 100) * 25;
            return Math.max(0, Math.min(100, Math.round(solarFactor + buildingFactor + greenFactor + commercialFactor)));
        }

        return { computeScore, computeEfficiency };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 3. ACTIVE MOBILITY ANALYSIS
    // ═══════════════════════════════════════════════════════════════

    const ActiveMobility = (() => {
        let _layerAdded = false;
        const SOURCE_ID = 'active-mobility-source';
        const LAYER_IDS = { footways: 'active-mobility-footways', cycleways: 'active-mobility-cycleways', gaps: 'active-mobility-gaps' };

        async function toggle() {
            _map = MapModule.getMap();
            if (_layerAdded) {
                const vis = _map.getLayoutProperty(LAYER_IDS.footways, 'visibility');
                const newVis = vis === 'visible' ? 'none' : 'visible';
                Object.values(LAYER_IDS).forEach(id => { if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility', newVis); });
                return newVis === 'visible';
            }

            App.showToast('Active Mobility', 'Loading pedestrian & cycling network...', 'info');
            try {
                const resp = await fetch(`${DATA_BASE}/vectors/osm_roads_guna.geojson`);
                if (!resp.ok) throw new Error('Roads data not available');
                const roads = await resp.json();

                const footways = { type: 'FeatureCollection', features: [] };
                const cycleways = { type: 'FeatureCollection', features: [] };
                const gaps = { type: 'FeatureCollection', features: [] };
                const activeTypes = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street']);
                const cycleTypes = new Set(['cycleway']);
                const mainRoads = new Set(['primary', 'secondary', 'tertiary', 'trunk']);

                roads.features.forEach(f => {
                    const hw = f.properties?.highway || '';
                    if (activeTypes.has(hw)) footways.features.push(f);
                    else if (cycleTypes.has(hw)) cycleways.features.push(f);
                    else if (mainRoads.has(hw) && !f.properties?.sidewalk && !f.properties?.cycleway) gaps.features.push(f);
                });

                _map.addSource(SOURCE_ID + '-foot', { type: 'geojson', data: footways });
                _map.addSource(SOURCE_ID + '-cycle', { type: 'geojson', data: cycleways });
                _map.addSource(SOURCE_ID + '-gaps', { type: 'geojson', data: gaps });

                _map.addLayer({ id: LAYER_IDS.footways, type: 'line', source: SOURCE_ID + '-foot',
                    paint: { 'line-color': '#22c55e', 'line-width': 3, 'line-opacity': 0.8 } });
                _map.addLayer({ id: LAYER_IDS.cycleways, type: 'line', source: SOURCE_ID + '-cycle',
                    paint: { 'line-color': '#06b6d4', 'line-width': 3, 'line-opacity': 0.8 } });
                _map.addLayer({ id: LAYER_IDS.gaps, type: 'line', source: SOURCE_ID + '-gaps',
                    paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [4, 3] } });

                _layerAdded = true;
                const coverage = ((footways.features.length + cycleways.features.length) / roads.features.length * 100).toFixed(1);
                App.showToast('Active Mobility',
                    'Footways: ' + footways.features.length + ' | Cycleways: ' + cycleways.features.length + ' | Gaps: ' + gaps.features.length + ' | Coverage: ' + coverage + '%',
                    'success');
                return true;
            } catch (err) { App.showToast('Active Mobility', err.message, 'error'); return false; }
        }

        function computeScore(features) {
            const f = features || {};
            const roads = f.road_network || 0;
            if (roads === 0) return 50;
            return Math.min(100, Math.round(((f.footpaths || 0) + (f.cycleways || 0)) / roads * 100));
        }

        return { toggle, computeScore };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 4. CITIZEN FEEDBACK / ISSUE REPORTING
    // ═══════════════════════════════════════════════════════════════

    const CitizenFeedback = (() => {
        const STORE_KEY = 'digipin_citizen_reports';
        const SOURCE_ID = 'citizen-reports-source';
        const LAYER_ID = 'citizen-reports-layer';
        let _layerAdded = false;

        const CATEGORIES = [
            { id: 'pothole', icon: '\u26A0', color: '#f97316', label: 'Pothole / Road Damage' },
            { id: 'flooding', icon: '\uD83C\uDF0A', color: '#3b82f6', label: 'Waterlogging / Flooding' },
            { id: 'garbage', icon: '\u267B', color: '#84cc16', label: 'Garbage / Waste Dumping' },
            { id: 'streetlight', icon: '\uD83D\uDCA1', color: '#eab308', label: 'Broken Street Light' },
            { id: 'encroachment', icon: '\uD83D\uDEA7', color: '#ef4444', label: 'Encroachment / Obstruction' },
            { id: 'drainage', icon: '\uD83D\uDCA7', color: '#06b6d4', label: 'Blocked Drain / Sewer' },
            { id: 'safety', icon: '\uD83D\uDEA8', color: '#dc2626', label: 'Safety Concern' },
            { id: 'other', icon: '\uD83D\uDCDD', color: '#8b5cf6', label: 'Other Issue' }
        ];

        function getReports() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; } }

        function saveReport(report) {
            const reports = getReports();
            reports.push({ ...report, id: Date.now(), timestamp: new Date().toISOString() });
            localStorage.setItem(STORE_KEY, JSON.stringify(reports));
            _updateMapLayer();
        }

        function openReportDialog(lat, lng) {
            const existing = document.getElementById('report-dialog');
            if (existing) existing.remove();

            const dialog = _el('div', { id: 'report-dialog', className: 'floating-dialog open',
                style: { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                    zIndex: '100001', width: '340px', padding: '16px', background: '#1a1a2e',
                    border: '1px solid rgba(0,229,255,0.3)', borderRadius: '12px' } });

            dialog.appendChild(_el('h3', { style: { margin: '0 0 12px', fontSize: '14px', color: '#00e5ff' } },
                'Report Issue at ' + lat.toFixed(4) + ', ' + lng.toFixed(4)));

            const grid = _el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' } });
            let selectedCat = null;

            CATEGORIES.forEach(cat => {
                const btn = _el('button', {
                    className: 'report-cat-btn',
                    style: { padding: '8px 6px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333',
                        borderRadius: '8px', color: '#ddd', fontSize: '11px', cursor: 'pointer', textAlign: 'left' }
                }, cat.icon + ' ' + cat.label);
                btn.addEventListener('click', () => {
                    grid.querySelectorAll('button').forEach(b => b.style.borderColor = '#333');
                    btn.style.borderColor = '#00e5ff';
                    selectedCat = cat.id;
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit Report';
                });
                grid.appendChild(btn);
            });
            dialog.appendChild(grid);

            const textarea = _el('textarea', { id: 'report-desc', placeholder: 'Describe the issue (optional)...',
                style: { width: '100%', height: '60px', background: '#111', border: '1px solid #333',
                    borderRadius: '8px', color: '#ddd', padding: '8px', fontSize: '12px', resize: 'none', boxSizing: 'border-box' } });
            dialog.appendChild(textarea);

            const actions = _el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } });
            const submitBtn = _el('button', { id: 'report-submit', disabled: 'true',
                style: { flex: '1', padding: '8px', background: '#00e5ff', color: '#000', border: 'none',
                    borderRadius: '8px', fontWeight: '600', cursor: 'pointer' } }, 'Select category first');
            submitBtn.addEventListener('click', () => {
                if (!selectedCat) return;
                saveReport({ lat, lng, category: selectedCat, description: textarea.value.trim() });
                dialog.remove();
                App.showToast('Report Saved', 'Issue reported: ' + (CATEGORIES.find(c => c.id === selectedCat)?.label || ''), 'success');
            });
            const cancelBtn = _el('button', { style: { padding: '8px 16px', background: '#333', color: '#ddd',
                border: 'none', borderRadius: '8px', cursor: 'pointer' } }, 'Cancel');
            cancelBtn.addEventListener('click', () => dialog.remove());
            actions.appendChild(submitBtn);
            actions.appendChild(cancelBtn);
            dialog.appendChild(actions);
            document.body.appendChild(dialog);
        }

        function toggleLayer() {
            _map = MapModule.getMap();
            if (_layerAdded) {
                const vis = _map.getLayoutProperty(LAYER_ID, 'visibility');
                const newVis = vis === 'visible' ? 'none' : 'visible';
                _map.setLayoutProperty(LAYER_ID, 'visibility', newVis);
                return newVis === 'visible';
            }

            const reports = getReports();
            _map.addSource(SOURCE_ID, { type: 'geojson', data: _toGeoJSON(reports) });
            _map.addLayer({
                id: LAYER_ID, type: 'circle', source: SOURCE_ID,
                paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'],
                    'circle-stroke-width': 2, 'circle-stroke-color': '#fff', 'circle-opacity': 0.9 }
            });
            _layerAdded = true;

            _map.on('click', LAYER_ID, (e) => {
                const p = e.features?.[0]?.properties;
                if (!p) return;
                const popup = _el('div', { style: { fontFamily: 'Inter,sans-serif', minWidth: '160px' } });
                popup.appendChild(_el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, esc(p.icon) + ' ' + esc(p.label)));
                if (p.description) popup.appendChild(_el('div', { style: { color: '#aaa', fontSize: '12px' } }, esc(p.description)));
                popup.appendChild(_el('div', { style: { color: '#666', fontSize: '11px', marginTop: '4px' } }, esc(p.timestamp)));
                new maplibregl.Popup({ className: 'dt-building-popup' }).setLngLat(e.lngLat).setDOMContent(popup).addTo(_map);
            });

            App.showToast('Citizen Reports', reports.length + ' reports on map', 'info');
            return true;
        }

        function _updateMapLayer() {
            if (!_layerAdded || !_map) return;
            _map.getSource(SOURCE_ID)?.setData(_toGeoJSON(getReports()));
        }

        function _toGeoJSON(reports) {
            return {
                type: 'FeatureCollection',
                features: reports.map(r => {
                    const cat = CATEGORIES.find(c => c.id === r.category) || CATEGORIES[7];
                    return {
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
                        properties: { color: cat.color, icon: cat.icon, label: cat.label,
                            description: r.description || '', timestamp: r.timestamp, id: r.id }
                    };
                })
            };
        }

        return { openReportDialog, toggleLayer, getReports, CATEGORIES };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 5. FLOOD EARLY WARNING (Open-Meteo Forecast)
    // ═══════════════════════════════════════════════════════════════

    const FloodWarning = (() => {
        let _panel = null;
        let _cnData;            // flood_cn_guna.json (data-driven Curve Number), loaded once
        let _cnTried = false;
        const RAIN_THRESHOLDS = { green: 10, yellow: 30, orange: 80, red: 150 };

        // Load the precomputed data-driven CN summary (ESA WorldCover x SoilGrids
        // HSG, AMC band). A small static artifact so the browser never parses
        // rasters; built by analysis/build_flood_cn_summary.py.
        async function _loadCn() {
            if (_cnTried) return;
            _cnTried = true;
            try {
                const r = await fetch('analysis/output/flood_cn_guna.json');
                if (r.ok) _cnData = await r.json();
            } catch (e) { /* fall back to a labelled default below */ }
        }

        // SCS-CN runoff: reuse the shared, parity-tested FloodSCS if present,
        // else an inline equivalent (same formula, configurable Ia/S ratio).
        function _runoffMm(P, cnValue, iaRatio) {
            if (typeof FloodSCS !== 'undefined') return FloodSCS.runoffMm(P, cnValue, iaRatio);
            if (!(P > 0) || !(cnValue > 0)) return 0;
            const S = (25400 / cnValue) - 254, Ia = iaRatio * S;
            return P > Ia ? Math.pow(P - Ia, 2) / ((P - Ia) + S) : 0;
        }

        async function open() {
            if (!_panel) _createPanel();
            _panel.classList.add('open');
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
            await _fetchForecast();
        }

        function _createPanel() {
            // Anchor explicitly: this dialog is appended to <body> after the page
            // content, so .floating-dialog's fixed top:auto would otherwise leave
            // it off-screen at the bottom of the tall page.
            _panel = _el('aside', { id: 'flood-warning', className: 'floating-dialog',
                style: { top: '72px', right: '16px', left: 'auto', width: 'min(380px, 94vw)' } });
            const header = _el('div', { className: 'panel-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' } });
            header.appendChild(_el('h3', { style: { margin: '0', fontSize: '15px' } }, 'Flood Early Warning'));
            const closeBtn = _el('button', { className: 'close-btn', 'aria-label': 'Close' });
            closeBtn.textContent = '\u00D7';
            closeBtn.addEventListener('click', () => _panel.classList.remove('open'));
            header.appendChild(closeBtn);
            _panel.appendChild(header);
            _panel.appendChild(_el('div', { id: 'flood-warn-content', className: 'panel-content', style: { padding: '8px 12px', maxHeight: '60vh', overflowY: 'auto' } }));
            document.body.appendChild(_panel);
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
        }

        async function _fetchForecast() {
            const c = _panel.querySelector('#flood-warn-content');
            c.replaceChildren();
            const loader = _el('div', { style: { textAlign: 'center', padding: '30px' } });
            loader.appendChild(_el('div', { className: 'spinner' }));
            loader.appendChild(_el('p', {}, 'Fetching 7-day rainfall forecast...'));
            c.appendChild(loader);
            await _loadCn();

            try {
                const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + GUNA.lat + '&longitude=' + GUNA.lon
                    + '&daily=precipitation_sum,precipitation_probability_max,weather_code,temperature_2m_max,wind_speed_10m_max'
                    + '&timezone=Asia/Kolkata&forecast_days=7';
                const resp = await fetch(url);
                const data = await resp.json();
                const daily = data.daily || {};
                const days = daily.time || [];

                c.replaceChildren();
                let maxRain = 0;

                // Build alert header (will be prepended after computing max)
                const alertDiv = _el('div', { style: { padding: '12px', marginBottom: '12px', textAlign: 'center', borderRadius: '8px' } });
                c.appendChild(alertDiv);
                c.appendChild(_el('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } }, '7-day rainfall forecast (Open-Meteo)'));

                const levelColors = { green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444' };

                days.forEach((date, i) => {
                    const rain = daily.precipitation_sum?.[i] || 0;
                    const prob = daily.precipitation_probability_max?.[i] || 0;
                    const temp = daily.temperature_2m_max?.[i];
                    const wind = daily.wind_speed_10m_max?.[i];
                    if (rain > maxRain) maxRain = rain;

                    const level = rain >= RAIN_THRESHOLDS.red ? 'red' : rain >= RAIN_THRESHOLDS.orange ? 'orange' : rain >= RAIN_THRESHOLDS.yellow ? 'yellow' : 'green';
                    const dayName = new Date(date).toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' });

                    const row = _el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px',
                        marginBottom: '4px', borderLeft: '3px solid ' + levelColors[level], borderRadius: '4px',
                        background: level === 'red' ? 'rgba(239,68,68,0.1)' : level === 'orange' ? 'rgba(249,115,22,0.1)' : 'rgba(0,0,0,0.1)' } });
                    row.appendChild(_el('div', { style: { width: '80px', fontSize: '12px', color: '#ddd' } }, dayName));
                    const info = _el('div', { style: { flex: '1', display: 'flex', alignItems: 'center', gap: '12px' } });
                    info.appendChild(_el('span', { style: { color: levelColors[level], fontWeight: '700', fontSize: '14px' } }, rain.toFixed(1) + 'mm'));
                    info.appendChild(_el('span', { style: { color: '#888', fontSize: '11px' } }, prob + '% chance'));
                    if (temp != null) info.appendChild(_el('span', { style: { color: '#888', fontSize: '11px' } }, temp + '\u00B0C'));
                    if (wind != null) info.appendChild(_el('span', { style: { color: '#888', fontSize: '11px' } }, wind + 'km/h'));
                    row.appendChild(info);
                    row.appendChild(_el('div', { style: { width: '20px', height: '20px', borderRadius: '50%', background: levelColors[level] } }));
                    c.appendChild(row);
                });

                // Update alert header
                const alertLevel = maxRain >= RAIN_THRESHOLDS.red ? 'RED' : maxRain >= RAIN_THRESHOLDS.orange ? 'ORANGE' : maxRain >= RAIN_THRESHOLDS.yellow ? 'YELLOW' : 'GREEN';
                const alertMsgs = {
                    GREEN: 'No significant rainfall expected. Normal operations.',
                    YELLOW: 'Moderate rain expected. Monitor low-lying areas.',
                    ORANGE: 'Heavy rain forecast. Pre-position pumps. Alert drainage teams.',
                    RED: 'Extreme rainfall alert! Activate flood response. Evacuate flood-prone zones.'
                };
                const aColor = levelColors[alertLevel.toLowerCase()];
                alertDiv.style.border = '1px solid ' + aColor;
                alertDiv.style.background = 'rgba(' + (alertLevel === 'RED' ? '239,68,68' : alertLevel === 'ORANGE' ? '249,115,22' : '0,229,255') + ',0.1)';
                alertDiv.appendChild(_el('div', { style: { fontSize: '22px', fontWeight: '700', color: aColor } }, 'ALERT: ' + alertLevel));
                alertDiv.appendChild(_el('div', { style: { fontSize: '12px', color: '#ccc', marginTop: '4px' } }, alertMsgs[alertLevel]));
                alertDiv.appendChild(_el('div', { style: { fontSize: '11px', color: '#888', marginTop: '4px' } },
                    'Max forecast: ' + maxRain.toFixed(1) + 'mm | Red threshold: ' + RAIN_THRESHOLDS.red + 'mm'));

                // SCS-CN runoff — data-driven Curve Number with a dry->wet AMC band.
                const runoff = _el('div', { style: { marginTop: '8px', padding: '8px', background: 'rgba(0,229,255,0.05)', borderRadius: '8px', fontSize: '12px' } });
                runoff.appendChild(_el('div', { style: { color: '#00e5ff', fontWeight: '600' } }, 'SCS-CN Runoff Estimate'));
                if (_cnData && _cnData.weighted_cn) {
                    const w = _cnData.weighted_cn;
                    const ia = _cnData.ia_ratio_primary || 0.05;
                    const qII = _runoffMm(maxRain, w.amc_ii, ia);
                    const qI = _runoffMm(maxRain, w.amc_i, ia);
                    const qIII = _runoffMm(maxRain, w.amc_iii, ia);
                    runoff.appendChild(_el('div', {}, 'CN ' + w.amc_ii + ' normal (dry ' + w.amc_i + ' – wet ' + w.amc_iii + ') | Ia/S=' + ia));
                    runoff.appendChild(_el('div', {}, 'Runoff from ' + maxRain.toFixed(1) + 'mm: ' + qII.toFixed(1) + 'mm normal, band ' + qI.toFixed(1) + '–' + qIII.toFixed(1) + 'mm'));
                    if (maxRain > 0) runoff.appendChild(_el('div', { style: { color: '#888', marginTop: '2px' } }, 'Runoff ratio: ' + (qII / maxRain * 100).toFixed(0) + '% (normal antecedent)'));
                    runoff.appendChild(_el('div', { style: { color: '#888', marginTop: '4px', fontSize: '10px' } },
                        'CN from ESA WorldCover × SoilGrids HSG (' + (_cnData.confidence || 'derived') + '). Screening-level — not validated design depth.'));
                } else {
                    const CN = 78;
                    const q = _runoffMm(maxRain, CN, 0.2);
                    runoff.appendChild(_el('div', {}, 'CN=' + CN + ' (default estimate — calibration data not loaded)'));
                    runoff.appendChild(_el('div', {}, 'Estimated runoff: ' + q.toFixed(1) + 'mm from ' + maxRain.toFixed(1) + 'mm rain'));
                    if (maxRain > 0) runoff.appendChild(_el('div', { style: { color: '#888', marginTop: '2px' } }, 'Runoff ratio: ' + (q / maxRain * 100).toFixed(0) + '%'));
                }
                c.appendChild(runoff);

                // At-risk buildings (3D) — per-building flood depth / risk extent
                if (typeof FloodBuildings !== 'undefined') {
                    const label = () => (FloodBuildings.isActive() ? 'Hide at-risk buildings' : 'Show at-risk buildings (3D)');
                    const bbtn = _el('button', { style: {
                        marginTop: '10px', width: '100%', padding: '9px 12px', cursor: 'pointer',
                        background: 'rgba(31,111,235,0.15)', color: '#cfe6ff',
                        border: '1px solid #1f6feb', borderRadius: '8px', fontSize: '12px', fontWeight: '600'
                    } }, label());
                    bbtn.addEventListener('click', () => {
                        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
                        Promise.resolve(FloodBuildings.toggle(map)).then(() => { bbtn.textContent = label(); });
                    });
                    c.appendChild(bbtn);
                }

                // Per-cell flood-risk heatmap (green->red) for planning flood-prone areas
                if (typeof FloodRiskGrid !== 'undefined') {
                    const rlabel = () => (FloodRiskGrid.isActive() ? 'Hide flood-risk cells' : 'Flood-risk cells (planning)');
                    const rbtn = _el('button', { style: {
                        marginTop: '8px', width: '100%', padding: '9px 12px', cursor: 'pointer',
                        background: 'rgba(215,48,39,0.14)', color: '#ffd9d2',
                        border: '1px solid #d73027', borderRadius: '8px', fontSize: '12px', fontWeight: '600'
                    } }, rlabel());
                    rbtn.addEventListener('click', () => {
                        const map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
                        Promise.resolve(FloodRiskGrid.toggle(map)).then(() => { rbtn.textContent = rlabel(); });
                    });
                    c.appendChild(rbtn);
                }
            } catch (err) {
                c.replaceChildren(_el('p', { style: { padding: '20px', color: '#ef4444' } }, 'Forecast error: ' + err.message));
            }
        }

        function close() { if (_panel) _panel.classList.remove('open'); }
        return { open, close };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 6. SCENARIO SIMULATION ENGINE
    // ═══════════════════════════════════════════════════════════════

    const ScenarioSim = (() => {
        let _panel = null;
        const INTERVENTIONS = [
            { id: 'add_hospital', icon: '\uD83C\uDFE5', label: 'Add Hospital', affects: { healthcare_access: 25, safety: 10, livability: 8 } },
            { id: 'add_school', icon: '\uD83C\uDFEB', label: 'Add School', affects: { education_score: 30, livability: 10, population_proxy: 5 } },
            { id: 'add_park', icon: '\uD83C\uDF33', label: 'Add Park (2 ha)', affects: { green: 20, livability: 12, noise_estimate: 8, walkability: 5 } },
            { id: 'add_metro', icon: '\uD83D\uDE87', label: 'Add Metro Station', affects: { connectivity: 35, walkability: 15, commercial: 10, investment: 20 } },
            { id: 'add_ev', icon: '\u26A1', label: 'Add EV Charging Hub', affects: { digital_readiness: 15, infra_maturity: 10, investment: 5 } },
            { id: 'add_market', icon: '\uD83D\uDED2', label: 'Add Market / Mall', affects: { commercial: 25, food_diversity: 15, entertainment_score: 10 } },
            { id: 'widen_road', icon: '\uD83D\uDEE3', label: 'Widen Main Road', affects: { connectivity: 20, walkability: -5, noise_estimate: -10, commercial: 5 } },
            { id: 'plant_trees', icon: '\uD83C\uDF32', label: 'Plant 500 Trees', affects: { green: 15, noise_estimate: 10, livability: 5 } }
        ];

        function open(cell, currentData) {
            if (!_panel) _createPanel();
            _panel.classList.add('open');
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
            _render(cell, currentData);
        }

        function _createPanel() {
            _panel = _el('aside', { id: 'scenario-sim', className: 'floating-dialog' });
            const header = _el('div', { className: 'panel-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' } });
            header.appendChild(_el('h3', { style: { margin: '0', fontSize: '15px' } }, 'Scenario Simulator'));
            const closeBtn = _el('button', { className: 'close-btn', 'aria-label': 'Close' });
            closeBtn.textContent = '\u00D7';
            closeBtn.addEventListener('click', () => _panel.classList.remove('open'));
            header.appendChild(closeBtn);
            _panel.appendChild(header);
            _panel.appendChild(_el('div', { id: 'scenario-content', className: 'panel-content', style: { padding: '8px 12px', maxHeight: '70vh', overflowY: 'auto' } }));
            document.body.appendChild(_panel);
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
        }

        function _render(cell, data) {
            const c = _panel.querySelector('#scenario-content');
            const scores = data?.scores || {};
            c.replaceChildren();

            c.appendChild(_el('div', { style: { fontSize: '11px', color: '#888', marginBottom: '8px' } },
                'What-if analysis for ' + (cell?.code || 'Selected Cell')));
            c.appendChild(_el('div', { style: { fontSize: '12px', color: '#aaa', marginBottom: '12px' } },
                'Select an intervention to see projected score changes:'));

            const resultDiv = _el('div', { id: 'scenario-result', style: { marginTop: '12px' } });

            INTERVENTIONS.forEach(intv => {
                const btn = _el('button', {
                    style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px 12px',
                        marginBottom: '6px', background: 'rgba(255,255,255,0.03)', border: '1px solid #333',
                        borderRadius: '8px', color: '#ddd', fontSize: '12px', cursor: 'pointer', textAlign: 'left' }
                });
                btn.appendChild(_el('span', { style: { fontSize: '18px' } }, intv.icon));
                btn.appendChild(_el('span', { style: { flex: '1' } }, intv.label));
                btn.appendChild(_el('span', { style: { color: '#666', fontSize: '10px' } }, Object.keys(intv.affects).length + ' metrics'));
                btn.addEventListener('mouseenter', () => btn.style.borderColor = '#00e5ff');
                btn.addEventListener('mouseleave', () => btn.style.borderColor = '#333');
                btn.addEventListener('click', () => _showResult(resultDiv, intv, scores));
                c.appendChild(btn);
            });

            c.appendChild(resultDiv);
        }

        function _showResult(container, intv, currentScores) {
            container.replaceChildren();
            const wrapper = _el('div', { style: { padding: '12px', background: 'rgba(0,229,255,0.05)',
                border: '1px solid rgba(0,229,255,0.2)', borderRadius: '8px' } });
            wrapper.appendChild(_el('div', { style: { fontWeight: '600', color: '#00e5ff', marginBottom: '8px' } },
                intv.icon + ' ' + intv.label + ' \u2014 Impact Analysis'));

            const table = _el('table', { style: { width: '100%', fontSize: '12px' } });
            const headerRow = _el('tr', { style: { color: '#888' } });
            ['Metric', 'Current', 'Projected', 'Change'].forEach(h => headerRow.appendChild(_el('th', { style: { textAlign: h === 'Metric' ? 'left' : 'center' } }, h)));
            table.appendChild(headerRow);

            for (const [key, delta] of Object.entries(intv.affects)) {
                const current = currentScores[key]?.value ?? 50;
                const projected = Math.max(0, Math.min(100, current + delta));
                const changeColor = delta > 0 ? '#22c55e' : '#ef4444';
                const arrow = delta > 0 ? '\u2191' : '\u2193';

                const row = _el('tr', { style: { borderTop: '1px solid #222' } });
                row.appendChild(_el('td', { style: { padding: '4px', textTransform: 'capitalize' } }, key.replace(/_/g, ' ')));
                row.appendChild(_el('td', { style: { textAlign: 'center', padding: '4px' } }, String(current)));
                row.appendChild(_el('td', { style: { textAlign: 'center', padding: '4px', fontWeight: '600' } }, String(projected)));
                row.appendChild(_el('td', { style: { textAlign: 'center', padding: '4px', color: changeColor, fontWeight: '600' } }, arrow + ' ' + Math.abs(delta)));
                table.appendChild(row);
            }
            wrapper.appendChild(table);

            const livCurrent = currentScores.livability?.value ?? 50;
            const livDelta = Object.entries(intv.affects).reduce((sum, [k, v]) => {
                if (['green', 'safety', 'healthcare_access', 'walkability', 'connectivity'].includes(k)) return sum + v * 0.15;
                return sum;
            }, 0);
            const livProjected = Math.max(0, Math.min(100, livCurrent + Math.round(livDelta)));
            wrapper.appendChild(_el('div', { style: { marginTop: '8px', padding: '6px', background: 'rgba(34,197,94,0.1)', borderRadius: '6px', fontSize: '12px' } },
                'Net Livability: ' + livCurrent + ' \u2192 ' + livProjected + ' (' + (livDelta >= 0 ? '+' : '') + Math.round(livDelta) + ')'));
            container.appendChild(wrapper);
        }

        function close() { if (_panel) _panel.classList.remove('open'); }
        return { open, close, INTERVENTIONS };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 7. EMERGENCY RESPONSE SIMULATION
    // ═══════════════════════════════════════════════════════════════

    const EmergencyResponse = (() => {
        let _panel = null;
        const DISASTER_TYPES = [
            { id: 'flood', icon: '\uD83C\uDF0A', label: 'Flood', radius: 1000 },
            { id: 'fire', icon: '\uD83D\uDD25', label: 'Fire', radius: 500 },
            { id: 'chemical', icon: '\u2623', label: 'Chemical Spill', radius: 800 },
            { id: 'earthquake', icon: '\uD83C\uDF0B', label: 'Earthquake', radius: 2000 }
        ];

        async function simulate(lat, lng, disasterType) {
            _map = MapModule.getMap();
            if (!_panel) _createPanel();
            _panel.classList.add('open');
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);

            const c = _panel.querySelector('#emergency-content');
            const disaster = DISASTER_TYPES.find(d => d.id === disasterType) || DISASTER_TYPES[0];
            c.replaceChildren();
            const loader = _el('div', { style: { textAlign: 'center', padding: '30px' } });
            loader.appendChild(_el('div', { className: 'spinner' }));
            loader.appendChild(_el('p', {}, 'Simulating ' + disaster.label + ' response...'));
            c.appendChild(loader);

            try {
                const data = await DataFetcher.fetchAllFeatures(lat, lng, 400);
                const features = data.features || {};
                const scores = data.scores || {};
                const hospitals = features.hospitals || 0;
                const fireStations = features.fire_stations || 0;
                const policeStations = features.police_stations || 0;
                const popDensity = scores.population_proxy?.value || 30;
                const affectedAreaKm2 = Math.PI * Math.pow(disaster.radius / 1000, 2);
                const estPopulation = Math.round(popDensity * affectedAreaKm2 * 100);
                const serviceScore = Math.min(100, (hospitals > 0 ? 30 : 0) + (fireStations > 0 ? 30 : 0) + (policeStations > 0 ? 20 : 0) + (scores.connectivity?.value || 0) * 0.2);

                _drawImpactZone(lat, lng, disaster.radius);

                c.replaceChildren();

                // Alert header
                const alert = _el('div', { style: { padding: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: '8px', marginBottom: '12px' } });
                alert.appendChild(_el('div', { style: { fontSize: '18px', fontWeight: '700', color: '#ef4444' } }, disaster.icon + ' ' + disaster.label + ' Response Plan'));
                alert.appendChild(_el('div', { style: { fontSize: '12px', color: '#aaa' } }, 'Location: ' + lat.toFixed(4) + ', ' + lng.toFixed(4) + ' | Radius: ' + disaster.radius + 'm'));
                c.appendChild(alert);

                // Metrics
                const metrics = _el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' } });
                const sColor = serviceScore >= 60 ? '#22c55e' : serviceScore >= 30 ? '#eab308' : '#ef4444';
                [{ val: estPopulation, label: 'Est. Affected', color: '#f97316' }, { val: serviceScore, label: 'Readiness Score', color: sColor }].forEach(m => {
                    const card = _el('div', { style: { padding: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', textAlign: 'center' } });
                    card.appendChild(_el('div', { style: { fontSize: '22px', fontWeight: '700', color: m.color } }, String(m.val)));
                    card.appendChild(_el('div', { style: { fontSize: '11px', color: '#888' } }, m.label));
                    metrics.appendChild(card);
                });
                c.appendChild(metrics);

                // Services
                c.appendChild(_el('div', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '6px' } }, 'Emergency Services'));
                const serviceList = _el('div', { style: { fontSize: '12px', marginBottom: '12px' } });
                [{ icon: '\uD83C\uDFE5', label: 'Hospitals', val: hospitals }, { icon: '\uD83D\uDE92', label: 'Fire Stations', val: fireStations },
                 { icon: '\uD83D\uDE93', label: 'Police', val: policeStations }].forEach(s => {
                    serviceList.appendChild(_el('div', { style: { padding: '4px 0', borderBottom: '1px solid #222' } }, s.icon + ' ' + s.label + ': ' + s.val));
                });
                serviceList.appendChild(_el('div', { style: { padding: '4px 0' } }, '\uD83D\uDE91 Road connectivity: ' + (scores.connectivity?.value || '-') + '/100'));
                c.appendChild(serviceList);

                // Actions
                c.appendChild(_el('div', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '6px' } }, 'Recommended Actions'));
                const actions = [];
                if (hospitals === 0) actions.push('Dispatch mobile medical unit \u2014 no hospital in zone');
                if (fireStations === 0 && disaster.id !== 'flood') actions.push('Alert nearest fire station for deployment');
                if (popDensity > 50) actions.push('High population density \u2014 prioritize evacuation');
                if ((scores.flood_risk?.value || 0) > 60) actions.push('Activate flood pumps \u2014 high flood risk zone');
                if ((scores.connectivity?.value || 0) < 40) actions.push('Poor road connectivity \u2014 use alternate routes');
                actions.push('Set up command post at nearest major intersection');
                actions.push('Activate emergency broadcast via PA system');

                const actionList = _el('div', { style: { fontSize: '12px' } });
                actions.forEach((a, i) => {
                    const item = _el('div', { style: { padding: '4px 0', borderBottom: '1px solid #222' } });
                    item.appendChild(_el('span', { style: { color: '#00e5ff' } }, (i + 1) + '. '));
                    item.appendChild(document.createTextNode(a));
                    actionList.appendChild(item);
                });
                c.appendChild(actionList);

                // Isochrone button
                const isoBtn = _el('button', { style: { marginTop: '12px', width: '100%', padding: '10px',
                    background: 'rgba(0,229,255,0.1)', border: '1px solid #00e5ff', borderRadius: '8px',
                    color: '#00e5ff', cursor: 'pointer', fontWeight: '600' } }, 'Show Evacuation Zones (Isochrone)');
                isoBtn.addEventListener('click', () => { if (typeof Isochrone !== 'undefined') Isochrone.show(lat, lng); });
                c.appendChild(isoBtn);
            } catch (err) {
                c.replaceChildren(_el('p', { style: { padding: '20px', color: '#ef4444' } }, 'Simulation error: ' + err.message));
            }
        }

        function _drawImpactZone(lat, lng, radius) {
            const sourceId = 'emergency-zone-source';
            const points = 64;
            const coords = [];
            for (let i = 0; i <= points; i++) {
                const angle = (i / points) * 2 * Math.PI;
                const dlat = (radius * Math.sin(angle)) / 111320;
                const dlng = (radius * Math.cos(angle)) / (111320 * Math.cos(lat * Math.PI / 180));
                coords.push([lng + dlng, lat + dlat]);
            }
            const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} }] };

            if (_map.getSource(sourceId)) {
                _map.getSource(sourceId).setData(geojson);
            } else {
                _map.addSource(sourceId, { type: 'geojson', data: geojson });
                _map.addLayer({ id: 'emergency-zone-layer', type: 'fill', source: sourceId,
                    paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.15 } });
                _map.addLayer({ id: 'emergency-zone-line', type: 'line', source: sourceId,
                    paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [4, 2] } });
            }
        }

        function clearZone() {
            if (_map?.getLayer('emergency-zone-layer')) _map.removeLayer('emergency-zone-layer');
            if (_map?.getLayer('emergency-zone-line')) _map.removeLayer('emergency-zone-line');
            if (_map?.getSource('emergency-zone-source')) _map.removeSource('emergency-zone-source');
        }

        function _createPanel() {
            _panel = _el('aside', { id: 'emergency-response', className: 'floating-dialog' });
            const header = _el('div', { className: 'panel-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' } });
            header.appendChild(_el('h3', { style: { margin: '0', fontSize: '15px' } }, 'Emergency Response'));
            const closeBtn = _el('button', { className: 'close-btn', 'aria-label': 'Close' });
            closeBtn.textContent = '\u00D7';
            closeBtn.addEventListener('click', () => { _panel.classList.remove('open'); clearZone(); });
            header.appendChild(closeBtn);
            _panel.appendChild(header);
            _panel.appendChild(_el('div', { id: 'emergency-content', className: 'panel-content', style: { padding: '8px 12px', maxHeight: '70vh', overflowY: 'auto' } }));
            document.body.appendChild(_panel);
            if (typeof FloatingDialogs !== 'undefined') FloatingDialogs.bringToFront(_panel);
        }

        function close() { if (_panel) _panel.classList.remove('open'); clearZone(); }
        return { simulate, close, clearZone, DISASTER_TYPES };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 8. URBAN HEAT ISLAND ANALYSIS
    // ═══════════════════════════════════════════════════════════════

    const HeatIsland = (() => {
        let _layerAdded = false;
        const SOURCE_ID = 'uhi-source';
        const LAYER_ID = 'uhi-layer';

        function estimateUHI(features, scores) {
            const f = features || {};
            const s = scores || {};
            const buildingDensity = Math.min((f.total_buildings || 0) / 40, 1);
            const greenDeficit = 1 - (s.green?.value || 0) / 100;
            const roadDensity = Math.min((f.road_network || 0) / 15, 1);
            const commercialIntensity = (s.commercial?.value || 0) / 100;
            return Math.round((buildingDensity * 2.0 + greenDeficit * 1.5 + roadDensity * 1.0 + commercialIntensity * 1.5) * 10) / 10;
        }

        async function showHeatmap() {
            _map = MapModule.getMap();
            App.showToast('Urban Heat Island', 'Computing heat island intensity...', 'info');

            const bounds = _map.getBounds();
            const gridSize = 6;
            const latStep = (bounds.getNorth() - bounds.getSouth()) / gridSize;
            const lngStep = (bounds.getEast() - bounds.getWest()) / gridSize;
            const features = [];
            const points = [];
            for (let i = 0; i < gridSize; i++) {
                for (let j = 0; j < gridSize; j++) {
                    points.push({ lat: bounds.getSouth() + latStep * (i + 0.5), lng: bounds.getWest() + lngStep * (j + 0.5), latStep, lngStep });
                }
            }

            for (let batch = 0; batch < points.length; batch += 6) {
                const chunk = points.slice(batch, batch + 6);
                const results = await Promise.allSettled(chunk.map(pt => DataFetcher.fetchAllFeatures(pt.lat, pt.lng, 400)));
                results.forEach((r, idx) => {
                    if (r.status !== 'fulfilled') return;
                    const pt = chunk[idx];
                    const uhi = estimateUHI(r.value.features, r.value.scores);
                    const color = uhi >= 4 ? '#ef4444' : uhi >= 3 ? '#f97316' : uhi >= 2 ? '#eab308' : uhi >= 1 ? '#84cc16' : '#22c55e';
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: [[[pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2], [pt.lng + pt.lngStep / 2, pt.lat - pt.latStep / 2], [pt.lng + pt.lngStep / 2, pt.lat + pt.latStep / 2], [pt.lng - pt.lngStep / 2, pt.lat + pt.latStep / 2], [pt.lng - pt.lngStep / 2, pt.lat - pt.latStep / 2]]] },
                        properties: { color, uhi, height: uhi * 80 }
                    });
                });
                if (batch + 6 < points.length) await new Promise(r => setTimeout(r, 200));
            }

            const geojson = { type: 'FeatureCollection', features };
            if (_map.getSource(SOURCE_ID)) {
                _map.getSource(SOURCE_ID).setData(geojson);
                _map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
            } else {
                _map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
                _map.addLayer({ id: LAYER_ID, type: 'fill-extrusion', source: SOURCE_ID,
                    paint: { 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.7 } });
            }
            _layerAdded = true;
            const maxUHI = Math.max(...features.map(f => f.properties.uhi));
            App.showToast('UHI Analysis', 'Max heat island: +' + maxUHI + '\u00B0C. Red=hottest. Pitch map for 3D view.', 'success');
        }

        function clear() { if (_map?.getSource(SOURCE_ID)) _map.getSource(SOURCE_ID).setData({ type: 'FeatureCollection', features: [] }); }

        function toggle() {
            if (_layerAdded && _map?.getLayoutProperty(LAYER_ID, 'visibility') === 'visible') {
                _map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
                return false;
            }
            showHeatmap();
            return true;
        }

        return { showHeatmap, clear, toggle, estimateUHI };
    })();

    // ═══════════════════════════════════════════════════════════════
    // 9. GENERATIVE DIGITAL TWIN — DATA GAP FILLING
    // ═══════════════════════════════════════════════════════════════

    const GenerativeTwin = (() => {
        async function inferDrainagePaths() {
            _map = MapModule.getMap();
            App.showToast('Generative Twin', 'Inferring drainage paths from building patterns...', 'info');

            try {
                const [roadResp, waterResp] = await Promise.all([
                    fetch(`${DATA_BASE}/vectors/osm_roads_guna.geojson`).catch(() => null),
                    fetch(`${DATA_BASE}/vectors/osm_water_guna.geojson`).catch(() => null)
                ]);

                const roads = roadResp?.ok ? await roadResp.json() : { features: [] };
                const water = waterResp?.ok ? await waterResp.json() : { features: [] };

                const bridges = roads.features.filter(f => f.properties?.bridge === 'yes' || f.properties?.man_made === 'bridge');
                const waterLines = water.features.filter(f => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString');
                const inferredPoints = [];

                bridges.forEach(b => {
                    if (b.geometry?.type === 'LineString' || b.geometry?.type === 'Point') {
                        const coords = b.geometry.type === 'Point' ? b.geometry.coordinates : b.geometry.coordinates[Math.floor(b.geometry.coordinates.length / 2)];
                        inferredPoints.push({ type: 'Feature', geometry: { type: 'Point', coordinates: coords },
                            properties: { source: 'bridge', label: b.properties?.name || 'Bridge crossing', confidence: 0.85 } });
                    }
                });

                waterLines.forEach(w => {
                    const coords = w.geometry.type === 'MultiLineString' ? w.geometry.coordinates[0] : w.geometry.coordinates;
                    if (coords?.length > 0) {
                        inferredPoints.push({ type: 'Feature', geometry: { type: 'Point', coordinates: coords[0] },
                            properties: { source: 'waterway_start', label: w.properties?.name || 'Waterway', confidence: 0.95 } });
                        inferredPoints.push({ type: 'Feature', geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
                            properties: { source: 'waterway_end', label: w.properties?.name || 'Waterway', confidence: 0.95 } });
                    }
                });

                const sourceId = 'inferred-drainage-source';
                const layerId = 'inferred-drainage-layer';
                const geojson = { type: 'FeatureCollection', features: inferredPoints };

                if (_map.getSource(sourceId)) {
                    _map.getSource(sourceId).setData(geojson);
                    _map.setLayoutProperty(layerId, 'visibility', 'visible');
                } else {
                    _map.addSource(sourceId, { type: 'geojson', data: geojson });
                    _map.addLayer({ id: layerId, type: 'circle', source: sourceId,
                        paint: { 'circle-radius': 6,
                            'circle-color': ['match', ['get', 'source'], 'bridge', '#f97316', 'waterway_start', '#06b6d4', 'waterway_end', '#06b6d4', '#8b5cf6'],
                            'circle-stroke-width': 2, 'circle-stroke-color': '#fff', 'circle-opacity': 0.9 } });

                    _map.on('click', layerId, (e) => {
                        const p = e.features?.[0]?.properties;
                        if (!p) return;
                        const popup = _el('div', { style: { fontFamily: 'Inter,sans-serif' } });
                        popup.appendChild(_el('div', { style: { fontWeight: '600' } }, esc(p.label)));
                        popup.appendChild(_el('div', { style: { color: '#888', fontSize: '11px' } },
                            'Source: ' + esc(p.source) + ' | Confidence: ' + Math.round((p.confidence || 0) * 100) + '%'));
                        new maplibregl.Popup({ className: 'dt-building-popup' }).setLngLat(e.lngLat).setDOMContent(popup).addTo(_map);
                    });
                }

                // Show existing waterways
                if (!_map.getLayer('existing-waterways')) {
                    _map.addSource('existing-waterways-src', { type: 'geojson', data: { type: 'FeatureCollection', features: waterLines } });
                    _map.addLayer({ id: 'existing-waterways', type: 'line', source: 'existing-waterways-src',
                        paint: { 'line-color': '#0ea5e9', 'line-width': 3, 'line-opacity': 0.8 } });
                }

                App.showToast('Generative Twin',
                    'Bridges: ' + bridges.length + ' | Waterways: ' + waterLines.length + ' | Anchor points: ' + inferredPoints.length, 'success');
            } catch (err) { App.showToast('Generative Twin', err.message, 'error'); }
        }

        return { inferDrainagePaths };
    })();

    // ═══════════════════════════════════════════════════════════════
    // TOOLBAR + PANEL INTEGRATION
    // ═══════════════════════════════════════════════════════════════

    function initToolbar() {
        _map = MapModule.getMap();
        const toolbar = document.getElementById('toolbar');
        if (!toolbar) return;

        const buttons = [
            { id: 'btn-ward-dash', icon: '\uD83D\uDCCA', label: 'Wards+', title: 'Ward KPI Dashboard', action: () => WardDashboard.open() },
            { id: 'btn-flood-warn', icon: '\uD83D\uDEA8', label: 'Flood', title: 'Flood Early Warning', action: () => FloodWarning.open() },
            // NOTE: ids are 'btn-st-*' (strategic-twin) to avoid colliding with the
            // ported Indore toolbar buttons (btn-mobility = L&O overlay, etc.),
            // which other overlay modules wire by getElementById.
            { id: 'btn-st-mobility', icon: '\uD83D\uDEB6', label: 'Walk', title: 'Active Mobility Network', action: () => ActiveMobility.toggle() },
            { id: 'btn-uhi', icon: '\uD83C\uDF21', label: 'UHI', title: 'Urban Heat Island', action: () => HeatIsland.toggle() },
            { id: 'btn-reports', icon: '\uD83D\uDCDD', label: 'Report', title: 'Citizen Issue Reports', action: () => CitizenFeedback.toggleLayer() },
            { id: 'btn-drainage', icon: '\uD83D\uDCA7', label: 'Drains', title: 'Inferred Drainage Paths', action: () => GenerativeTwin.inferDrainagePaths() }
        ];

        buttons.forEach(btn => {
            const el = _el('button', { className: 'toolbar-btn', id: btn.id, title: btn.title });
            el.appendChild(_el('span', { className: 'tb-icon' }, btn.icon));
            el.appendChild(_el('span', { className: 'tb-label' }, btn.label));
            el.addEventListener('click', btn.action);
            toolbar.appendChild(el);
        });

        // Right-click on map opens report dialog
        _map.on('contextmenu', (e) => CitizenFeedback.openReportDialog(e.lngLat.lat, e.lngLat.lng));
    }

    function hookDetailPanel() {
        const observer = new MutationObserver(() => {
            const panel = document.getElementById('panel-content');
            if (!panel) return;
            const actionsRow = panel.querySelector('.panel-actions');
            // 'btn-st-scenario' avoids colliding with the ported toolbar's
            // 'btn-scenario' (CA-ML growth-scenario lens, wired by scenario-panel.js).
            if (actionsRow && !actionsRow.querySelector('#btn-st-scenario')) {
                const scenarioBtn = _el('button', { className: 'action-btn', id: 'btn-st-scenario', title: 'What-If Scenario' }, '\uD83D\uDD2C Scenario');
                scenarioBtn.addEventListener('click', () => {
                    const cell = Panel.getCurrentCell?.();
                    const data = Panel.getCurrentData?.();
                    if (cell && data) ScenarioSim.open(cell, data);
                });
                actionsRow.appendChild(scenarioBtn);

                const emerBtn = _el('button', { className: 'action-btn', id: 'btn-emergency', title: 'Emergency Response' }, '\uD83D\uDEA8 Emergency');
                emerBtn.addEventListener('click', () => {
                    const cell = Panel.getCurrentCell?.();
                    if (cell) EmergencyResponse.simulate(cell.center.lat, cell.center.lng, 'flood');
                });
                actionsRow.appendChild(emerBtn);
            }
        });
        const panel = document.getElementById('detail-panel');
        if (panel) observer.observe(panel, { childList: true, subtree: true });
    }

    function init() {
        const waitForMap = setInterval(() => {
            if (typeof MapModule !== 'undefined' && MapModule.getMap()) {
                clearInterval(waitForMap);
                initToolbar();
                hookDetailPanel();
                console.log('[StrategicTwin] 9 strategic features initialized');
            }
        }, 500);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    return { WardDashboard, CarbonFootprint, ActiveMobility, CitizenFeedback, FloodWarning, ScenarioSim, EmergencyResponse, HeatIsland, GenerativeTwin, init };
})();
