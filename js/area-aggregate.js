/**
 * AreaAggregate — drag a rectangle on the map → aggregated intelligence for
 * every DIGIPIN cell inside it (count + per-score avg/min/max), not just one
 * cell. Same viewport-sampling + DataFetcher pattern as the overlays, scoped to
 * the drawn rectangle, shown in a small floating summary box.
 *
 * `aggregate`, `rectFromPoints`, `rectContains`, `samplePoints` are pure and
 * unit-tested. The drag interaction + render can only be eyeballed in a real
 * browser (basemap is CDN-blocked in CI). Idempotent attach/detach/toggle.
 */
const AreaAggregate = (() => {
    const SRC = 'area-aggregate-src';
    const FILL = 'area-aggregate-fill';
    const LINE = 'area-aggregate-line';
    const BOX_ID = 'area-aggregate-box';
    const GRID = 8;                 // up to 8×8 sample points inside the rectangle
    const SAMPLE_RADIUS_M = 300;
    // Headline scores summarised at the top of the box (rest collapse below).
    const HEADLINE = ['livability', 'safety', 'green', 'walkability', 'connectivity', 'flood_risk'];

    let _active = false;
    let _map = null;
    let _abort = null;
    let _drawing = false;
    let _start = null;

    // ---------- pure helpers ----------
    /** Axis-aligned rect {west,south,east,north} from two {lat,lng} corners. */
    function rectFromPoints(a, b) {
        return {
            west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
            south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
        };
    }
    /** True if lat/lng falls inside the rect. */
    function rectContains(rect, lat, lng) {
        return lng >= rect.west && lng <= rect.east && lat >= rect.south && lat <= rect.north;
    }
    /** Evenly spaced cell-centre sample points covering the rect (n×n). */
    function samplePoints(rect, n) {
        const pts = [];
        const latStep = (rect.north - rect.south) / n;
        const lngStep = (rect.east - rect.west) / n;
        if (!(latStep > 0) || !(lngStep > 0)) return pts;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                pts.push({ lat: rect.south + latStep * (i + 0.5), lng: rect.west + lngStep * (j + 0.5) });
            }
        }
        return pts;
    }
    /**
     * Collapse sample points that fall in the same DIGIPIN cell to one, keyed by
     * DigiPin code, so the count reflects *distinct cells* — not a fixed 64. For
     * an area smaller than a cell all samples share a code → one cell (instead of
     * reporting 64 duplicates). Pure (given DigiPin.encode). Falls back to the raw
     * points if DigiPin is unavailable.
     */
    function dedupeByCell(pts) {
        if (typeof DigiPin === 'undefined' || !DigiPin.encode) return pts;
        const seen = new Set();
        const out = [];
        for (const p of pts) {
            let code;
            try { code = DigiPin.encode(p.lat, p.lng); } catch { code = null; }
            const key = code || `${p.lat},${p.lng}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(p);
        }
        return out;
    }
    /** Aggregate scores across sampled cells → {count, perScore:{key:{avg,min,max,label}}}. Pure.
     *  Accepts fetchAllFeatures results ({scores:{k:{value,label}}}) or plain {k:value} maps. */
    function aggregate(cells) {
        const acc = {};
        let count = 0;
        for (const c of cells || []) {
            if (!c) continue;
            const scores = c.scores || c;
            if (!scores || typeof scores !== 'object') continue;
            let any = false;
            for (const k in scores) {
                const raw = scores[k];
                const v = (raw && typeof raw === 'object') ? raw.value : raw;
                if (!Number.isFinite(v)) continue;
                any = true;
                const p = acc[k] || (acc[k] = { sum: 0, min: Infinity, max: -Infinity, n: 0,
                    label: (raw && raw.label) || k });
                p.sum += v; p.n++;
                if (v < p.min) p.min = v;
                if (v > p.max) p.max = v;
            }
            if (any) count++;
        }
        const perScore = {};
        for (const k in acc) {
            const p = acc[k];
            perScore[k] = { avg: Math.round(p.sum / p.n), min: Math.round(p.min), max: Math.round(p.max), label: p.label };
        }
        return { count, perScore };
    }

    // ---------- map interaction ----------
    function _empty() { return { type: 'FeatureCollection', features: [] }; }
    function _rectFeature(rect) {
        return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[
            [rect.west, rect.south], [rect.east, rect.south], [rect.east, rect.north],
            [rect.west, rect.north], [rect.west, rect.south],
        ]] } };
    }
    function _ensureLayer() {
        if (_map.getSource(SRC)) return;
        _map.addSource(SRC, { type: 'geojson', data: _empty() });
        _map.addLayer({ id: FILL, type: 'fill', source: SRC,
            paint: { 'fill-color': '#00f5ff', 'fill-opacity': 0.12 } });
        _map.addLayer({ id: LINE, type: 'line', source: SRC,
            paint: { 'line-color': '#00f5ff', 'line-width': 1.5, 'line-dasharray': [2, 1] } });
    }
    function _setRect(rect) {
        const s = _map.getSource(SRC);
        if (s) s.setData({ type: 'FeatureCollection', features: rect ? [_rectFeature(rect)] : [] });
    }

    function _onDown(e) {
        if (!_active) return;
        _drawing = true;
        _start = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        if (_map.dragPan) _map.dragPan.disable();
    }
    function _onMove(e) {
        if (!_drawing) return;
        _setRect(rectFromPoints(_start, { lat: e.lngLat.lat, lng: e.lngLat.lng }));
    }
    function _onUp(e) {
        if (!_drawing) return;
        _drawing = false;
        if (_map.dragPan) _map.dragPan.enable();
        const rect = rectFromPoints(_start, { lat: e.lngLat.lat, lng: e.lngLat.lng });
        _setRect(rect);
        _runAggregate(rect);
    }

    async function _runAggregate(rect) {
        if (typeof DataFetcher === 'undefined') return;
        if (_abort) _abort.abort();
        _abort = new AbortController();
        const signal = _abort.signal;
        const pts = dedupeByCell(samplePoints(rect, GRID));
        if (!pts.length) return;
        _renderBox({ loading: true, sampled: pts.length });
        const cells = [];
        let rejected = 0;
        for (let b = 0; b < pts.length; b += 6) {
            if (signal.aborted) return;
            const chunk = pts.slice(b, b + 6);
            const res = await Promise.allSettled(
                chunk.map(p => DataFetcher.fetchAllFeatures(p.lat, p.lng, SAMPLE_RADIUS_M)));
            res.forEach(r => {
                if (r.status === 'fulfilled' && r.value) cells.push(r.value);
                else if (r.status === 'rejected') rejected++;
            });
            if (b + 6 < pts.length) await new Promise(r => setTimeout(r, 200));
        }
        if (signal.aborted) return;
        // Every fetch failed (offline / network) — distinguish from a genuinely
        // empty area so the user knows to retry rather than assume "no data".
        if (cells.length === 0 && rejected === pts.length) {
            _renderBox({ error: true });
            return;
        }
        _renderBox({ agg: aggregate(cells) });
    }

    function _palette() {
        if (typeof Theme !== 'undefined' && Theme.palette) return Theme.palette();
        return { primary: '#00f5ff', ink: '#e2e8f0', sub: '#94a3b8',
            surface: 'rgba(10,14,39,0.92)', border: 'rgba(255,255,255,0.12)' };
    }
    /** Render/update the floating summary box. */
    function _renderBox({ loading, sampled, agg, error } = {}) {
        let el = document.getElementById(BOX_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = BOX_ID;
            el.setAttribute('role', 'group');
            el.setAttribute('aria-label', 'Area aggregate summary');
            el.setAttribute('aria-live', 'polite');   // announce updates to screen readers
            document.body.appendChild(el);
        }
        const pal = _palette();
        // Right-anchored: the default sidebar is fixed top-left (top:80px,
        // left:16px, z-index:900), so a left-anchored box would render beneath it.
        el.style.cssText = `position:absolute;top:84px;right:16px;z-index:950;max-width:260px;`
            + `background:${pal.surface};border:1px solid ${pal.border};border-radius:10px;`
            + `padding:12px 14px;color:${pal.ink};font:12px/1.5 system-ui,sans-serif;`
            + 'box-shadow:0 4px 18px rgba(0,0,0,0.32);backdrop-filter:blur(8px);';
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        let body;
        if (loading) {
            body = `<div style="color:${pal.sub};">Sampling ${esc(sampled)} cells…</div>`;
        } else if (error) {
            body = `<div style="color:${pal.sub};">Couldn't load data (offline?). Drag again to retry.</div>`;
        } else if (agg && agg.count > 0) {
            const keys = HEADLINE.filter(k => agg.perScore[k])
                .concat(Object.keys(agg.perScore).filter(k => !HEADLINE.includes(k)));
            const rows = keys.slice(0, 8).map(k => {
                const p = agg.perScore[k];
                return `<div style="display:flex;justify-content:space-between;gap:10px;margin:2px 0;">`
                    + `<span style="color:${pal.sub};">${esc(p.label)}</span>`
                    + `<span><b>${esc(p.avg)}</b> <span style="color:${pal.sub};">(${esc(p.min)}–${esc(p.max)})</span></span></div>`;
            }).join('');
            body = `<div style="margin-bottom:6px;color:${pal.sub};">${esc(agg.count)} cells sampled · avg (min–max)</div>${rows}`;
        } else {
            body = `<div style="color:${pal.sub};">No scored cells in this area.</div>`;
        }
        el.innerHTML = `<div style="font-weight:600;font-size:14px;margin-bottom:8px;color:${pal.primary};">Area summary</div>`
            + body
            + `<div style="margin-top:8px;color:${pal.sub};font-size:10px;">Drag on the map to select another area.</div>`;
    }
    function _removeBox() { const el = document.getElementById(BOX_ID); if (el) el.remove(); }

    function attach() {
        _active = true;
        _map = (typeof MapModule !== 'undefined') ? MapModule.getMap() : null;
        if (!_map) return;
        _ensureLayer();
        // Pointer + touch, so the drag works on phones/tablets too (e.lngLat is
        // populated identically for touch events).
        _map.on('mousedown', _onDown);
        _map.on('mousemove', _onMove);
        _map.on('mouseup', _onUp);
        _map.on('touchstart', _onDown);
        _map.on('touchmove', _onMove);
        _map.on('touchend', _onUp);
        if (_map.getCanvas) _map.getCanvas().style.cursor = 'crosshair';   // draw-mode cue
        if (typeof App !== 'undefined') App.showToast('Area summary', 'Drag a rectangle on the map to aggregate it.', 'info');
        _renderBox();   // initial hint box
    }
    function detach() {
        _active = false;
        _drawing = false;
        if (_abort) { _abort.abort(); _abort = null; }
        // Use the stored map (the one we registered on) — re-fetching could yield
        // a different/undefined instance and leak the listeners.
        if (_map) {
            _map.off('mousedown', _onDown);
            _map.off('mousemove', _onMove);
            _map.off('mouseup', _onUp);
            _map.off('touchstart', _onDown);
            _map.off('touchmove', _onMove);
            _map.off('touchend', _onUp);
            if (_map.dragPan) _map.dragPan.enable();
            if (_map.getCanvas) _map.getCanvas().style.cursor = '';
            if (_map.getLayer(FILL)) _map.removeLayer(FILL);
            if (_map.getLayer(LINE)) _map.removeLayer(LINE);
            if (_map.getSource(SRC)) _map.removeSource(SRC);
            _map = null;
        }
        _removeBox();
    }
    function toggle() { if (_active) detach(); else attach(); }
    function isVisible() { return _active; }

    return { attach, detach, toggle, isVisible, aggregate, rectFromPoints, rectContains, samplePoints, dedupeByCell };
})();

if (typeof window !== 'undefined') window.AreaAggregate = AreaAggregate;
