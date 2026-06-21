/**
 * EmergencyAccessOverlay — paints the Emergency Accessibility Index as a
 * choropleth: every scored DIGIPIN cell coloured by how easily police /
 * authorities can REACH it in an incident (green = Reachable → red = Isolated).
 *
 * Both inputs are committed local JSON (mobility_grid.json + traffic_grid.json),
 * so the whole scored grid is built once from EmergencyAccess.sampleGrids and
 * rendered as a single GeoJSON fill source — no per-cell fetch, instant.
 * Idempotent attach/detach/toggle with an isStyleLoaded guard, mirroring the
 * established overlay contract (mobility-overlay.js / score-choropleth.js).
 */
const EmergencyAccessOverlay = (() => {
    const SRC = 'emergency-access-src';
    const FILL_LAYER = 'emergency-access-fill';
    const LINE_LAYER = 'emergency-access-outline';
    const LEGEND_ID = 'emergency-access-legend';

    let _active = false;
    let _map = null;
    let _loading = false;

    /** Current MapLibre map instance, or null if MapModule isn't ready. */
    function _map_() { return (typeof MapModule !== 'undefined') ? MapModule.getMap() : null; }

    /** Bounding box [west,south,east,north] for a row-major cell index of a grid. */
    function _cellBBox(computed, i) {
        const b = computed.bounds, nx = computed.nx, ny = computed.ny;
        const x = i % nx, y = Math.floor(i / nx);     // row 0 = north
        const cw = (b.east - b.west) / nx;
        const ch = (b.north - b.south) / ny;
        const west = b.west + x * cw;
        const east = west + cw;
        const north = b.north - y * ch;
        const south = north - ch;
        return [west, south, east, north];
    }

    /** Build a GeoJSON FeatureCollection of coloured cell polygons from a computed grid. */
    function _buildGeoJSON(computed) {
        const features = [];
        const n = computed.index.length;
        for (let i = 0; i < n; i++) {
            const eai = computed.index[i];
            if (eai == null) continue;
            const band = computed.band[i];
            const [w, s, e, nth] = _cellBBox(computed, i);
            const color = (typeof EmergencyAccessScore !== 'undefined' && EmergencyAccessScore.classColor)
                ? EmergencyAccessScore.classColor(band) : '#9ca3af';
            features.push({
                type: 'Feature',
                properties: { eai, band, color },
                geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, nth], [w, nth], [w, s]]] },
            });
        }
        return { type: 'FeatureCollection', features };
    }

    /** Add the source + fill/outline layers once, or update data thereafter. */
    function _paint(geojson) {
        if (!_map.getSource(SRC)) {
            _map.addSource(SRC, { type: 'geojson', data: geojson });
            _map.addLayer({
                id: FILL_LAYER, type: 'fill', source: SRC,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.5 },
            });
            _map.addLayer({
                id: LINE_LAYER, type: 'line', source: SRC,
                paint: { 'line-color': ['get', 'color'], 'line-width': 0.3, 'line-opacity': 0.5 },
            });
        } else {
            _map.getSource(SRC).setData(geojson);
        }
    }

    /** Load both grids, compute the EAI for every cell, and paint the choropleth. */
    async function refresh() {
        _map = _map_();
        if (!_map || _loading) return;
        if (typeof EmergencyAccess === 'undefined') return;
        _loading = true;
        if (typeof App !== 'undefined') App.showToast('Emergency Access', 'Computing accessibility…', 'info');
        try {
            const { mobGrid, trafGrid } = await EmergencyAccess.loadGrids();
            if (!_active) return;
            const computed = EmergencyAccess.sampleGrids(mobGrid, trafGrid);
            if (!computed) {
                if (typeof App !== 'undefined') App.showToast('Emergency Access',
                    'No accessibility grid for this region (run the pipeline).', 'warning');
                return;
            }
            const gj = _buildGeoJSON(computed);
            // Defer until the style is ready so addSource/addLayer never throw.
            if (_map.isStyleLoaded && !_map.isStyleLoaded()) {
                _map.once('idle', () => { if (_active) { _paint(gj); _renderLegend(); } });
            } else {
                _paint(gj);
                _renderLegend();
            }
            if (typeof App !== 'undefined') App.showToast('Emergency Access',
                `${gj.features.length} cells scored — green = reachable, red = isolated.`, 'success');
        } catch (e) {
            console.warn('[EmergencyAccessOverlay] refresh failed', e);
        } finally {
            _loading = false;
        }
    }

    /** Theme palette, with a dark-mode fallback when Theme is unavailable. */
    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }

    /** Create or refresh the bottom-left legend listing the EAI bands. */
    function _renderLegend() {
        let el = document.getElementById(LEGEND_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = LEGEND_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Emergency accessibility legend');
            document.body.appendChild(el);
        }
        const pal = _palette();
        el.style.cssText = `position:absolute;bottom:24px;left:24px;z-index:5;background:${pal.surface};`
            + `border:1px solid ${pal.border};border-radius:10px;padding:12px 14px;color:${pal.ink};`
            + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const classes = (typeof EmergencyAccessScore !== 'undefined') ? EmergencyAccessScore.CLASSES : [];
        const rows = classes.map(c => `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">`
            + `<span style="width:12px;height:12px;border-radius:3px;background:${c.color};border:1px solid #fff;flex:none;"></span>`
            + `<span style="color:${pal.sub};">${c.label}</span></div>`).join('');
        el.innerHTML = `<div style="font-weight:600;font-size:15px;margin-bottom:8px;color:${pal.primary};">Emergency Accessibility</div>`
            + rows
            + `<div style="margin-top:6px;color:${pal.sub};font-size:11px;">How fast police/authorities can reach each cell · structural, OSM-derived</div>`;
    }
    /** Remove the legend element if present. */
    function _removeLegend() { const el = document.getElementById(LEGEND_ID); if (el) el.remove(); }

    /** Activate the overlay and paint. */
    function attach() { _active = true; refresh(); }
    /** Deactivate: drop the legend and remove layers/source. */
    function detach() {
        _active = false;
        _removeLegend();
        const map = _map_();
        if (!map) return;
        if (map.getLayer(FILL_LAYER)) map.removeLayer(FILL_LAYER);
        if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
        if (map.getSource(SRC)) map.removeSource(SRC);
    }
    /** Toggle the overlay on/off. */
    function toggle() { if (_active) detach(); else attach(); }
    /** Whether the overlay is currently active. */
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, refresh };
})();

if (typeof window !== 'undefined') window.EmergencyAccessOverlay = EmergencyAccessOverlay;
