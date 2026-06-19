/**
 * TrafficOverlay — paints the road network by Level-of-Service (structural
 * congestion). Two data paths:
 *
 *   1. Precomputed (preferred): loads data/traffic/<region>/road_los.geojson
 *      (from pipeline/traffic/road_network.py) — each road carries a betweenness-
 *      derived LOS grade A–F + criticality. Critical/bottleneck "bridge" links
 *      are drawn thicker.
 *   2. Fallback (no precomputed file): fetches the viewport's roads live from
 *      Overpass (like ward-overlay.js) and colours them by OSM-class capacity
 *      only (no betweenness) — labelled honestly so it's not mistaken for the
 *      full model. Gives an immediate, useful layer everywhere.
 *
 * Standard overlay contract: idempotent attach/detach/toggle/isVisible, single
 * source+layers cleaned up on detach, theme-aware legend. colorFor/gradeForRoad
 * are pure and unit-tested.
 *
 * Honest framing: structural congestion, NOT real-time delays. docs/TRAFFIC_MODEL.md
 */
const TrafficOverlay = (() => {
    const SOURCE_ID = 'traffic-overlay-src';
    const LINE_ID   = 'traffic-overlay-line';
    const CRIT_ID   = 'traffic-overlay-critical';
    const LEGEND_ID = 'traffic-legend';
    const REGION    = 'indore_pilot';
    const GEOJSON_URL = `./data/traffic/${REGION}/road_los.geojson`;
    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

    // LOS A (free-flow, green) → F (breakdown, deep red). Sequential ramp.
    const BANDS = [
        { grade: 'F', color: '#7f0000', label: 'F — breakdown' },
        { grade: 'E', color: '#d7301f', label: 'E — at capacity' },
        { grade: 'D', color: '#ef6548', label: 'D — congested' },
        { grade: 'C', color: '#fc8d59', label: 'C — busy' },
        { grade: 'B', color: '#fdbb84', label: 'B — stable' },
        { grade: 'A', color: '#31a354', label: 'A — free-flow' },
    ];
    const _COLOR = BANDS.reduce((m, b) => (m[b.grade] = b.color, m), {});

    let _active = false;
    let _map = null;
    let _abort = null;
    let _mode = 'precomputed';   // or 'class_based' (Overpass fallback)
    let _popup = null;

    /** Colour for a LOS grade ('A'..'F'), transparent when unknown. */
    function colorFor(grade) {
        return _COLOR[grade] || 'rgba(0,0,0,0)';
    }

    /** Derive a LOS grade for a road feature from its props. Uses the precomputed
     *  los_grade if present, else a class-capacity-only grade (fallback path). */
    function gradeForRoad(props) {
        if (props && props.los_grade) return props.los_grade;
        if (typeof TrafficScore === 'undefined') return null;
        const cap = TrafficScore.capacityForClass(props && props.highway);
        // Fallback proxy: high-capacity arterials carry more load → worse LOS.
        const los = TrafficScore.losFromVC(cap);
        return los ? los.grade : null;
    }

    /** Current MapLibre map instance, or null if MapModule isn't ready. */
    function _map_() { return (typeof MapModule !== 'undefined') ? MapModule.getMap() : null; }

    /** Add the source + LOS line / critical-link layers on first paint, or update data thereafter. */
    function _paint(geojson) {
        if (!_map.getSource(SOURCE_ID)) {
            _map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
            _map.addLayer({
                id: LINE_ID, type: 'line', source: SOURCE_ID,
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 4],
                    'line-opacity': 0.85,
                },
            });
            // Critical / bottleneck links emphasised on top.
            _map.addLayer({
                id: CRIT_ID, type: 'line', source: SOURCE_ID,
                filter: ['==', ['get', 'is_critical'], true],
                paint: {
                    'line-color': '#000000',
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 7],
                    'line-opacity': 0.45,
                },
            });
            _map.on('click', LINE_ID, _onClick);
            _map.on('mouseenter', LINE_ID, () => { _map.getCanvas().style.cursor = 'pointer'; });
            _map.on('mouseleave', LINE_ID, () => { _map.getCanvas().style.cursor = ''; });
        } else {
            _map.getSource(SOURCE_ID).setData(geojson);
        }
    }

    /** Open a popup describing the clicked road (name, LOS grade, risk, criticality). */
    function _onClick(e) {
        const p = (e.features && e.features[0] && e.features[0].properties) || {};
        /** HTML-escape a value for safe insertion into the popup markup. */
        const esc = (v) => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const grade = gradeForRoad(p);
        let html = `<div style="font-family:Inter,sans-serif;font-size:12px;">`
            + `<strong>${esc(p.name) || esc(p.highway) || 'Road'}</strong>`
            + `<br>LOS <strong>${esc(grade || '—')}</strong>`;
        if (p.congestion_risk != null) html += ` · risk ${esc(p.congestion_risk)}/100`;
        if (p.betweenness != null) html += `<br>betweenness ${esc(p.betweenness)}`;
        if (p.is_bridge) html += `<br>⚠ critical link (single point of failure)`;
        html += '</div>';
        if (_popup) _popup.remove();
        if (typeof maplibregl !== 'undefined') {
            _popup = new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(_map);
        }
    }

    /** Tag features with a `color` (from LOS) + `is_critical` flag for the paint. */
    function _decorate(features) {
        for (const f of features) {
            const p = f.properties || (f.properties = {});
            p.color = colorFor(gradeForRoad(p));
            // Emphasise only genuinely critical links (high-betweenness bridges),
            // not every graph bridge — an arterial-only network has many of those.
            p.is_critical = (p.criticality === 'critical');
        }
        return features;
    }

    /** Fetch the precomputed LOS GeoJSON artifact, or null when absent/unreachable. */
    async function _loadPrecomputed(signal) {
        try {
            const r = await fetch(GEOJSON_URL, { cache: 'force-cache', signal });
            if (!r.ok) return null;
            const gj = await r.json();
            _decorate(gj.features || []);
            return gj;
        } catch { return null; }
    }

    /** Fallback: fetch the viewport's roads live from Overpass and build a class-based FeatureCollection. */
    async function _loadOverpass(signal) {
        const b = _map.getBounds();
        const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
        const q = `[out:json][timeout:25];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"](${bbox}););out geom;`;
        const resp = await fetch(OVERPASS_URL, {
            method: 'POST', signal,
            body: `data=${encodeURIComponent(q)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
        const data = await resp.json();
        const features = [];
        (data.elements || []).forEach(el => {
            if (!el.geometry) return;
            const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
            if (coords.length < 2) return;
            features.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords },
                properties: { highway: el.tags?.highway, name: el.tags?.name },
            });
        });
        _decorate(features);
        return { type: 'FeatureCollection', features };
    }

    /** Load roads (precomputed LOS, else Overpass fallback) and (re)paint the layer + legend. */
    async function refresh() {
        _map = _map_();
        if (!_map) return;
        if (_abort) _abort.abort();
        _abort = new AbortController();
        const signal = _abort.signal;

        if (typeof App !== 'undefined') App.showToast('Traffic', 'Loading road network…', 'info');
        let gj = await _loadPrecomputed(signal);
        _mode = 'precomputed';
        if (!gj || !(gj.features || []).length) {
            // No precomputed artifact → live class-based fallback for the viewport.
            _mode = 'class_based';
            try { gj = await _loadOverpass(signal); }
            catch (e) {
                if (typeof App !== 'undefined') App.showToast('Traffic', `Road fetch failed: ${e.message}`, 'error');
                return;
            }
        }
        if (signal.aborted || !_active) return;
        _paint(gj);
        _renderLegend();
        if (typeof App !== 'undefined') {
            App.showToast('Traffic',
                `${(gj.features || []).length} roads (${_mode === 'precomputed' ? 'LOS · betweenness' : 'class-based, no centrality'}).`,
                'success');
        }
    }

    // ---- legend ----
    /** Theme palette, with a dark-mode fallback when Theme is unavailable. */
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }
    /** Create or refresh the bottom-left legend listing LOS bands and mode note. */
    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Traffic Level-of-Service legend');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = `position:absolute;bottom:24px;left:24px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:12px 14px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const rows = BANDS.map(b => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + `<span style="width:16px;height:4px;border-radius:2px;background:${b.color};flex:none;"></span>`
            + `<span style="color:${pal.sub};">${b.label}</span></div>`).join('');
        const note = _mode === 'precomputed'
            ? 'Structural congestion · betweenness ÷ road capacity → LOS'
            : 'Class-based estimate (no centrality) · run the pipeline for full LOS';
        el.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px;color:${pal.primary};">Traffic — Level of Service</div>`
            + rows
            + `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;"><span style="width:16px;height:4px;background:#000;opacity:.55;flex:none;"></span><span style="color:${pal.sub};">critical link</span></div>`
            + `<div style="margin-top:6px;color:${pal.sub};font-size:11px;">${note}</div>`;
    }
    /** Remove the legend element if present. */
    function _removeLegend() { const el = document.getElementById(LEGEND_ID); if (el) el.remove(); }

    /** Activate the overlay and load data. */
    function attach() { _active = true; refresh(); }
    /** Deactivate the overlay: abort fetches, drop the popup/legend, and remove layers/source. */
    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        if (_popup) { _popup.remove(); _popup = null; }
        _removeLegend();
        const map = _map_();
        if (!map) return;
        if (map.getLayer(CRIT_ID)) map.removeLayer(CRIT_ID);
        if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
    /** Toggle the overlay on/off. */
    function toggle() { if (_active) detach(); else attach(); }
    /** Whether the overlay is currently active. */
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, refresh, colorFor, gradeForRoad, BANDS };
})();

if (typeof window !== 'undefined') window.TrafficOverlay = TrafficOverlay;
