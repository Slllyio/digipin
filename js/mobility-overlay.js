/**
 * MobilityOverlay — marks where law-and-order / emergency movement can be choked
 * or sealed off. Loads data/safety/<region>/chokepoints.geojson (from
 * pipeline/safety/mobility.py) and draws:
 *   • point chokepoints — rail level crossings, toll booths, lift gates (circles)
 *   • critical/seal links — sole-connector road segments (thick lines)
 * with a legend + click details. Defensive resilience view (keep access open),
 * mirroring the ward/traffic overlay contract: idempotent attach/detach/toggle.
 *
 * colorFor / radiusFor are pure and unit-tested. See docs/MOBILITY_MODEL.md.
 */
const MobilityOverlay = (() => {
    const SRC = 'mobility-overlay-src';
    const PT_LAYER = 'mobility-overlay-points';
    const LINE_LAYER = 'mobility-overlay-lines';
    const LEGEND_ID = 'mobility-legend';
    const REGION = 'indore_pilot';
    const URL = `./data/safety/${REGION}/chokepoints.geojson`;

    // kind → colour + legend label. Lines (seal/critical) vs points (OSM chokepoints).
    const KINDS = [
        { kind: 'level_crossing', color: '#b30000', label: 'Rail level crossing', type: 'point' },
        { kind: 'toll_booth',     color: '#e34a33', label: 'Toll booth',          type: 'point' },
        { kind: 'lift_gate',      color: '#fc8d59', label: 'Lift gate',           type: 'point' },
        { kind: 'seal_link',      color: '#7a0177', label: 'Sealable-pocket link', type: 'line' },
        { kind: 'critical_link',  color: '#000000', label: 'Critical link',       type: 'line' },
    ];
    const _COLOR = KINDS.reduce((m, k) => (m[k.kind] = k.color, m), {});

    let _active = false;
    let _map = null;
    let _abort = null;
    let _popup = null;

    /** Colour for a chokepoint kind (grey when unknown). */
    function colorFor(kind) {
        return _COLOR[kind] || '#9ca3af';
    }
    /** Circle radius emphasis: high-severity chokepoints draw larger. */
    function radiusFor(severity) {
        return severity === 'high' ? 7 : 5;
    }

    function _map_() { return (typeof MapModule !== 'undefined') ? MapModule.getMap() : null; }

    function _decorate(features) {
        for (const f of features) {
            const p = f.properties || (f.properties = {});
            p.color = colorFor(p.kind);
            p.radius = radiusFor(p.severity);
        }
        return features;
    }

    function _paint(geojson) {
        if (!_map.getSource(SRC)) {
            _map.addSource(SRC, { type: 'geojson', data: geojson });
            _map.addLayer({
                id: LINE_LAYER, type: 'line', source: SRC,
                filter: ['==', ['geometry-type'], 'LineString'],
                paint: { 'line-color': ['get', 'color'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 6],
                    'line-opacity': 0.85 },
            });
            _map.addLayer({
                id: PT_LAYER, type: 'circle', source: SRC,
                filter: ['==', ['geometry-type'], 'Point'],
                paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['get', 'radius'],
                    'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-opacity': 0.9 },
            });
            _map.on('click', PT_LAYER, _onClick);
            _map.on('mouseenter', PT_LAYER, _onEnter);
            _map.on('mouseleave', PT_LAYER, _onLeave);
        } else {
            _map.getSource(SRC).setData(geojson);
        }
    }

    function _onEnter() { if (_map) _map.getCanvas().style.cursor = 'pointer'; }
    function _onLeave() { if (_map) _map.getCanvas().style.cursor = ''; }

    function _onClick(e) {
        const p = (e.features && e.features[0] && e.features[0].properties) || {};
        const esc = (v) => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const label = (KINDS.find(k => k.kind === p.kind) || {}).label || p.kind || 'Chokepoint';
        let html = `<div style="font-family:Inter,sans-serif;font-size:12px;"><strong>${esc(label)}</strong>`;
        if (p.name) html += `<br>${esc(p.name)}`;
        html += `<br>Can throttle/seal access here — keep clear during incidents.</div>`;
        if (_popup) _popup.remove();
        if (typeof maplibregl !== 'undefined') {
            _popup = new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(_map);
        }
    }

    async function refresh() {
        _map = _map_();
        if (!_map) return;
        if (_abort) _abort.abort();
        _abort = new AbortController();
        const signal = _abort.signal;
        if (typeof App !== 'undefined') App.showToast('Law & Order Mobility', 'Loading chokepoints…', 'info');
        let gj;
        try {
            const r = await fetch(URL, { cache: 'force-cache', signal });
            if (!r.ok) throw new Error(`no data (${r.status})`);
            gj = await r.json();
        } catch (e) {
            if (typeof App !== 'undefined') App.showToast('Law & Order Mobility',
                'No chokepoint data for this region (run the pipeline).', 'warning');
            return;
        }
        if (signal.aborted || !_active) return;
        _decorate(gj.features || []);
        _paint(gj);
        _renderLegend();
        if (typeof App !== 'undefined') App.showToast('Law & Order Mobility',
            `${(gj.features || []).length} access chokepoints marked.`, 'success');
    }

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }
    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Law and order mobility legend');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = `position:absolute;bottom:24px;left:24px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:12px 14px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const rows = KINDS.map(k => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + (k.type === 'line'
                ? `<span style="width:16px;height:4px;border-radius:2px;background:${k.color};flex:none;"></span>`
                : `<span style="width:12px;height:12px;border-radius:50%;background:${k.color};border:1px solid #fff;flex:none;"></span>`)
            + `<span style="color:${pal.sub};">${k.label}</span></div>`).join('');
        el.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px;color:${pal.primary};">Law &amp; Order Mobility</div>`
            + rows
            + `<div style="margin-top:6px;color:${pal.sub};font-size:11px;">Access chokepoints to keep open in an incident · structural, OSM-derived</div>`;
    }
    function _removeLegend() { const el = document.getElementById(LEGEND_ID); if (el) el.remove(); }

    function attach() { _active = true; refresh(); }
    function detach() {
        _active = false;
        if (_abort) { _abort.abort(); _abort = null; }
        if (_popup) { _popup.remove(); _popup = null; }
        _removeLegend();
        const map = _map_();
        if (!map) return;
        map.off('click', PT_LAYER, _onClick);
        map.off('mouseenter', PT_LAYER, _onEnter);
        map.off('mouseleave', PT_LAYER, _onLeave);
        if (map.getLayer(PT_LAYER)) map.removeLayer(PT_LAYER);
        if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
        if (map.getSource(SRC)) map.removeSource(SRC);
    }
    function toggle() { if (_active) detach(); else attach(); }
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, refresh, colorFor, radiusFor, KINDS };
})();

if (typeof window !== 'undefined') window.MobilityOverlay = MobilityOverlay;
