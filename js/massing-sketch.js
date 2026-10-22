/**
 * MassingSketch — sketch a proposed building on the 3D city and see what it
 * does: its height in floors, gross floor area, the FAR it adds to the
 * DIGIPIN cell it stands in, and (with the sun study open) the shadow it
 * casts at that hour.
 *
 * Draw: "Draw footprint", then click the corners on the map; click the first
 * corner again, double-click, or press Enter to finish (Esc cancels, Backspace
 * drops the last corner). Each proposal gets floors (3.2 m each) and a use,
 * draws as a terracotta block among the real buildings, and is kept in this
 * browser (localStorage) and in share links (`ms=`). Export gives GeoJSON
 * with height and GFA on every footprint.
 *
 * ringAreaM2()/gfa()/toFeature()/parseParam()/toParam() are pure (unit-tested).
 */
const MassingSketch = (() => {
    const SRC = 'massing-src', LAYER = 'massing-layer';
    const DRAFT_SRC = 'massing-draft-src', DRAFT_LINE = 'massing-draft-line', DRAFT_PTS = 'massing-draft-pts';
    const PANEL_ID = 'massing-panel';
    const STORE = 'digipin_massing';
    const FLOOR_M = 3.2;
    const MAX_PROPOSALS = 8;
    const USES = { residential: 'Residential', commercial: 'Commercial', mixed: 'Mixed use', civic: 'Civic' };
    const RAD = Math.PI / 180;

    /** Area of a lng/lat ring in m² (equirectangular about its mean latitude; fine at block scale). Pure. */
    function ringAreaM2(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return 0;
        const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        const kx = 111320 * Math.cos(lat0 * RAD), ky = 110540;
        let a = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
        }
        return Math.abs(a) / 2;
    }

    /** Gross floor area (m²) for a footprint and floor count. Pure. */
    function gfa(areaM2, floors) {
        return Math.max(0, areaM2) * Math.max(1, Math.round(floors || 1));
    }

    /** A closed ring (first = last), or null when there are under 3 corners. Pure. */
    function closeRing(points) {
        const pts = (points || []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (pts.length < 3) return null;
        const a = pts[0], z = pts[pts.length - 1];
        return a[0] === z[0] && a[1] === z[1] ? pts : [...pts, a];
    }

    /** GeoJSON feature for a proposal { id, name, floors, use, ring }. Pure. */
    function toFeature(p) {
        const area = ringAreaM2(p.ring);
        return {
            type: 'Feature',
            properties: { id: p.id, name: p.name, use: p.use, floors: p.floors, height_m: +(p.floors * FLOOR_M).toFixed(1),
                footprint_m2: Math.round(area), gfa_m2: Math.round(gfa(area, p.floors)), proposed: true },
            geometry: { type: 'Polygon', coordinates: [p.ring] },
        };
    }

    /** Share-link payload → proposals (malformed entries dropped). Pure. */
    function parseParam(raw) {
        let arr;
        try { arr = JSON.parse(raw); } catch { return []; }
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const x of arr.slice(0, MAX_PROPOSALS)) {
            const ring = closeRing(Array.isArray(x && x.r) ? x.r.map(p => [Number(p[0]), Number(p[1])]) : []);
            const floors = Math.round(Number(x && x.f));
            if (!ring || !(floors >= 1 && floors <= 200)) continue;
            out.push({ id: `m${out.length + 1}`, name: String((x && x.n) || `Proposal ${out.length + 1}`).slice(0, 40),
                floors, use: USES[x && x.u] ? x.u : 'mixed', clear: !(x && x.c === 0), ring });
        }
        return out;
    }

    /** Proposals → compact share-link payload (6-decimal corners). Pure. */
    function toParam(list) {
        return JSON.stringify((list || []).slice(0, MAX_PROPOSALS).map(p => ({
            n: p.name, f: p.floors, u: p.use, ...(p.clear === false ? { c: 0 } : {}), r: p.ring.slice(0, -1).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]),
        })));
    }

    // ── runtime ────────────────────────────────────────────────────────────
    let _map = null, _panel = null;
    let _list = [];
    let _draft = null;      // [[lng,lat], ...] while drawing
    let _seq = 0;
    let _clearSig = '[]';

    function _theme() { return typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
    function _esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function _toast(t, m, k) { if (typeof App !== 'undefined' && App.showToast) App.showToast(t, m, k || 'info'); }

    function _save() {
        try { localStorage.setItem(STORE, toParam(_list)); } catch { /* private mode */ }
        if (typeof URLState !== 'undefined' && URLState.sync) { try { URLState.sync(); } catch { /* best-effort */ } }
    }
    function _load() {
        try { const raw = localStorage.getItem(STORE); return raw ? parseParam(raw) : []; } catch { return []; }
    }

    function list() { return _list.map(p => ({ ...p })); }
    let _swallowUntil = 0;  // the finishing click must not also select the cell under it
    function isDrawing() { return !!_draft || Date.now() < _swallowUntil; }

    /** Rings of proposals that replace what stands on their site (OvertureBuildings drops those buildings). */
    function clearRings() { return _list.filter(p => p.clear !== false).map(p => p.ring); }

    /** Footprints for SunShadows: [{ ring, h }]. */
    function footprints() { return _list.map(p => ({ ring: p.ring, h: p.floors * FLOOR_M, p: true })); }

    function _ensureLayers() {
        if (!_map || _map.getSource(SRC)) return;
        _map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        _map.addLayer({ id: LAYER, type: 'fill-extrusion', source: SRC, paint: {
            'fill-extrusion-color': ['match', ['get', 'use'], 'residential', '#e8825f', 'commercial', '#d9643f', 'civic', '#c9a24a', '#e0734d'],
            'fill-extrusion-height': ['get', 'height_m'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.93,
            'fill-extrusion-vertical-gradient': true } });
        _map.addSource(DRAFT_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        _map.addLayer({ id: DRAFT_LINE, type: 'line', source: DRAFT_SRC, filter: ['==', ['geometry-type'], 'LineString'],
            paint: { 'line-color': '#e0734d', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
        _map.addLayer({ id: DRAFT_PTS, type: 'circle', source: DRAFT_SRC, filter: ['==', ['geometry-type'], 'Point'],
            paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#e0734d', 'circle-stroke-width': 2 } });
    }

    function _paint() {
        if (!_map) return;
        try {
            _ensureLayers();
            _map.getSource(SRC).setData({ type: 'FeatureCollection', features: _list.map(toFeature) });
            const d = _draft || [];
            const feats = d.map(p => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
            if (d.length >= 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: d.length >= 3 ? [...d, d[0]] : d } });
            _map.getSource(DRAFT_SRC).setData({ type: 'FeatureCollection', features: feats });
        } catch { /* style reloading */ }
        // Cleared sites drop their buildings from the 3D city (shadows follow the twin).
        const sig = JSON.stringify(clearRings());
        if (sig !== _clearSig) {
            _clearSig = sig;
            if (typeof OvertureBuildings !== 'undefined' && OvertureBuildings.refreshTwin) OvertureBuildings.refreshTwin();
        }
        // Proposals cast shadows too.
        if (typeof SunStudy !== 'undefined' && SunStudy.isActive && SunStudy.isActive() && SunStudy.applyToMap) SunStudy.applyToMap();
    }

    // Drawing ----------------------------------------------------------------
    function _onClick(e) {
        if (!_draft) return;
        const p = [e.lngLat.lng, e.lngLat.lat];
        if (_draft.length >= 3) {
            const first = _map.project(_draft[0]);
            if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 12) { _finish(); return; }
        }
        _draft.push(p);
        _paint();
        _renderPanel();
    }
    function _onDbl(e) { if (_draft) { e.preventDefault(); _finish(); } }
    function _onKey(e) {
        if (!_draft) return;
        if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
        else if (e.key === 'Enter') _finish();
        else if (e.key === 'Backspace' && !/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) {
            e.preventDefault(); _draft.pop(); _paint(); _renderPanel();
        }
    }

    function startDraw() {
        _map = _map || (typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null);
        if (!_map) return false;
        if (_list.length >= MAX_PROPOSALS) { _toast('Massing', `Up to ${MAX_PROPOSALS} proposals; delete one first.`, 'warning'); return false; }
        _draft = [];
        _map.getCanvas().style.cursor = 'crosshair';
        if (_map.doubleClickZoom) _map.doubleClickZoom.disable();
        _paint();
        _renderPanel();
        return true;
    }

    function cancel() {
        _draft = null;
        if (_map) {
            _map.getCanvas().style.cursor = '';
            if (_map.doubleClickZoom) setTimeout(() => _map.doubleClickZoom.enable(), 300);
        }
        _paint();
        _renderPanel();
    }

    function _finish() {
        const ring = closeRing(_draft);
        if (!ring) { _toast('Massing', 'A footprint needs at least three corners.', 'warning'); return; }
        add({ ring, floors: 8, use: 'mixed' });
        _swallowUntil = Date.now() + 400;
        cancel();
    }

    /** Add a proposal { ring, floors, use, name? }; returns its id. */
    function add(p) {
        const ring = closeRing(p && p.ring);
        if (!ring || _list.length >= MAX_PROPOSALS) return null;
        const id = `m${++_seq}`;
        _list.push({ id, name: (p.name || `Proposal ${_list.length + 1}`).slice(0, 40), floors: Math.max(1, Math.min(200, Math.round(p.floors || 8))),
            use: USES[p.use] ? p.use : 'mixed', clear: p.clear !== false, ring });
        _save(); _paint(); _renderPanel();
        return id;
    }

    function update(id, patch) {
        const p = _list.find(x => x.id === id);
        if (!p) return;
        if (patch.floors != null) p.floors = Math.max(1, Math.min(200, Math.round(Number(patch.floors) || 1)));
        if (patch.use && USES[patch.use]) p.use = patch.use;
        if (patch.name != null) p.name = String(patch.name).slice(0, 40) || p.name;
        if (patch.clear != null) p.clear = !!patch.clear;
        _save(); _paint(); _renderPanel();
    }

    function remove(id) {
        _list = _list.filter(x => x.id !== id);
        _save(); _paint(); _renderPanel();
    }

    /** Replace every proposal (share links). */
    function setAll(list) {
        _list = [];
        _seq = 0;
        for (const p of list || []) add(p);
        if (!(list || []).length) { _save(); _paint(); _renderPanel(); }
    }

    /** Code and area (m²) of the L7 (~245 m) DIGIPIN cell holding the proposal's centre. */
    function _cellFor(p) {
        if (typeof DigiPin === 'undefined' || !DigiPin.encode) return null;
        const n = p.ring.length - 1;
        const lng = p.ring.slice(0, n).reduce((s, q) => s + q[0], 0) / n, lat = p.ring.slice(0, n).reduce((s, q) => s + q[1], 0) / n;
        try {
            const code = DigiPin.encode(lat, lng).replace(/-/g, '').slice(0, 7);   // L7 ~245 m: block-scale FAR
            const b = DigiPin.decodePartial(code).bounds;
            return { code: DigiPin.format ? DigiPin.format(code) : code,
                area: ringAreaM2([[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]]) };
        } catch { return null; }
    }

    function exportGeoJSON() {
        if (!_list.length || typeof document === 'undefined') return 0;
        const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: _list.map(toFeature) })], { type: 'application/geo+json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `digipin-proposed-massing-${new Date().toISOString().slice(0, 10)}.geojson`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return _list.length;
    }

    // Panel -------------------------------------------------------------------
    function _renderPanel() {
        if (!_panel) return;
        const rows = _list.map(p => {
            const area = ringAreaM2(p.ring), g = gfa(area, p.floors), cell = _cellFor(p);
            const far = cell && cell.area ? (g / cell.area) : null;
            return `<div class="ms-item" data-id="${p.id}">
                <div class="ms-row"><input class="ms-name" value="${_esc(p.name)}" aria-label="Proposal name">
                <button type="button" class="ms-del" data-act="del" aria-label="Delete ${_esc(p.name)}" title="Delete">✕</button></div>
                <div class="ms-row"><label>Floors <input type="number" class="ms-floors" min="1" max="200" value="${p.floors}"></label>
                <select class="ms-use" aria-label="Use">${Object.entries(USES).map(([k, v]) => `<option value="${k}"${k === p.use ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
                <label class="ms-clear"><input type="checkbox" class="ms-clear-cb"${p.clear !== false ? ' checked' : ''}> Clear existing buildings on site</label>
                <div class="ms-facts">${(p.floors * FLOOR_M).toFixed(0)} m tall · footprint ${Math.round(area).toLocaleString('en-IN')} m² · GFA ${Math.round(g).toLocaleString('en-IN')} m²`
                + (far != null ? `<br>Adds FAR ${far.toFixed(2)} to cell ${_esc(cell.code)} (~${Math.round(Math.sqrt(cell.area))} m)` : '') + '</div></div>';
        }).join('');
        const drawing = !!_draft;
        _panel.querySelector('.ms-body').innerHTML =
            (drawing ? `<div class="ms-hint" role="status">Click the corners on the map${_draft.length ? ` (${_draft.length} so far)` : ''}. Click the first corner again, double-click or use Finish shape; Esc cancels.</div>` : '')
            + (rows || (drawing ? '' : '<div class="ms-hint">Sketch a proposed building to see its floor area, density and shadow among the real city.</div>'))
            + '<div class="ms-actions">'
            + (drawing && _draft.length >= 3 ? '<button type="button" data-act="finish" class="ms-primary">Finish shape</button>' : '')
            + `<button type="button" data-act="${drawing ? 'cancel' : 'draw'}"${drawing ? '' : ' class="ms-primary"'}>${drawing ? 'Cancel' : 'Draw footprint'}</button>`
            + (_list.length ? '<button type="button" data-act="export">Export GeoJSON</button>' : '') + '</div>'
            + (_list.length ? '<div class="ms-note">Open Sun to see each proposal’s shadow at an hour.</div>' : '');
    }

    function _buildPanel() {
        const el = document.createElement('div');
        el.id = PANEL_ID;
        el.className = 'massing-panel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Proposed massing');
        el.innerHTML = '<div class="ms-head"><span class="ms-title">Proposed massing</span><button type="button" class="ms-close" aria-label="Close proposed massing">✕</button></div><div class="ms-body"></div>';
        el.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            if (b.classList.contains('ms-close')) { toggle(); return; }
            const act = b.dataset.act, id = b.closest('.ms-item') && b.closest('.ms-item').dataset.id;
            if (act === 'draw') startDraw();
            else if (act === 'cancel') cancel();
            else if (act === 'finish') _finish();
            else if (act === 'del' && id) remove(id);
            else if (act === 'export') exportGeoJSON();
        });
        el.addEventListener('change', (e) => {
            const it = e.target.closest('.ms-item');
            if (!it) return;
            if (e.target.classList.contains('ms-floors')) update(it.dataset.id, { floors: e.target.value });
            else if (e.target.classList.contains('ms-use')) update(it.dataset.id, { use: e.target.value });
            else if (e.target.classList.contains('ms-name')) update(it.dataset.id, { name: e.target.value });
            else if (e.target.classList.contains('ms-clear-cb')) update(it.dataset.id, { clear: e.target.checked });
        });
        document.body.appendChild(el);
        return el;
    }

    /** Open/close the panel (the toolbar button). Returns the new state. */
    function toggle() {
        if (_panel) {
            if (_draft) cancel();
            _panel.remove();
            _panel = null;
            _syncBtn(false);
            return false;
        }
        _map = _map || (typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null);
        _panel = _buildPanel();
        _renderPanel();
        _syncBtn(true);
        // Proposals are 3D: tilt into 3D if the map is flat.
        const btn3d = document.getElementById('btn-3d');
        if (btn3d && !btn3d.classList.contains('active')) btn3d.click();
        if (!_list.length) startDraw();
        return true;
    }

    function isOpen() { return !!_panel; }

    function _syncBtn(on) {
        const b = typeof document !== 'undefined' && document.getElementById('btn-massing');
        if (!b) return;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
    }

    function init() {
        _map = typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
        if (!_list.length) {
            const saved = _load();
            if (saved.length) setAll(saved);
        }
        if (_map) {
            _map.on('click', _onClick);
            _map.on('dblclick', _onDbl);
            _map.on('style.load', () => _paint());
            if (_map.loaded && _map.loaded()) _paint(); else _map.once('load', _paint);
        }
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', _onKey, true);
            const b = document.getElementById('btn-massing');
            if (b) { b.setAttribute('aria-pressed', 'false'); b.addEventListener('click', () => toggle()); }
        }
    }

    return { init, toggle, isOpen, isDrawing, startDraw, cancel, add, update, remove, setAll, list, footprints, clearRings,
        exportGeoJSON, ringAreaM2, gfa, closeRing, toFeature, parseParam, toParam, FLOOR_M, LAYER };
})();

if (typeof window !== 'undefined') {
    window.MassingSketch = MassingSketch;
}
