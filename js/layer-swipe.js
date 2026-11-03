/**
 * LayerSwipe — compare two sets of map layers side by side with a draggable
 * divider (the idea of opengeos/maplibre-gl-swipe, MIT, rebuilt for this app).
 *
 * MapLibre cannot clip one layer to half the screen, so the right side is a
 * second, non-interactive map built from a snapshot of the main map's style,
 * kept on the same camera and clipped with CSS to the right of the divider.
 * The left side is the main map itself. Pick what each side shows from the
 * overlays that are on (grouped by source); everything else stays on both.
 *
 * Pure helpers (overlayGroups, visibilityPlan, clipInset, clampPosition) are
 * unit-tested; open/close are idempotent and restore every layer they hid.
 */
const LayerSwipe = (() => {
    const WRAP_ID = 'layer-swipe-wrap';
    const PANEL_ID = 'layer-swipe-panel';
    // Basemap sources from the CARTO styles; their layers stay on both sides.
    const BASE_SOURCES = new Set(['carto', 'openmaptiles', 'composite']);

    let _map = null;
    let _right = null;      // second maplibregl.Map
    let _wrap = null;
    let _panel = null;
    let _pos = 0.5;         // divider position, 0..1 of the map width
    let _left = '';         // group key shown only on the left
    let _rightKey = '';     // group key shown only on the right
    let _hiddenOnMain = []; // layer ids this module hid on the main map
    let _onMove = null;
    let _onResize = null;

    // ---------- pure helpers ----------

    /** Readable name for a source/layer id: 'cell-layer-growth' → 'Cell layer growth'. */
    function prettify(id) {
        const s = String(id || '').replace(/[-_]+/g, ' ').replace(/\b(src|source|layer|lyr|fill|line)\b/gi, '').replace(/\s+/g, ' ').trim();
        return s ? s[0].toUpperCase() + s.slice(1) : String(id);
    }

    /**
     * Visible overlay layers grouped by source, basemap excluded.
     * @param {Array} layers  style.layers
     * @param {(id:string)=>string} visibilityOf  layout visibility per layer id
     * @returns {Array<{key,label,layerIds}>}
     */
    function overlayGroups(layers, visibilityOf = () => 'visible') {
        const groups = new Map();
        (layers || []).forEach(l => {
            if (!l || l.type === 'background' || !l.source || BASE_SOURCES.has(l.source)) return;
            if (visibilityOf(l.id) === 'none') return;
            if (!groups.has(l.source)) groups.set(l.source, { key: l.source, label: prettify(l.source), layerIds: [] });
            groups.get(l.source).layerIds.push(l.id);
        });
        return [...groups.values()];
    }

    /**
     * Which layer ids to hide on each side. Left shows everything except the
     * right-only group; right shows everything except the left-only group.
     */
    function visibilityPlan(groups, leftKey, rightKey) {
        const ids = k => ((groups.find(g => g.key === k) || {}).layerIds || []);
        if (leftKey && leftKey === rightKey) return { hideLeft: [], hideRight: [] };
        return { hideLeft: ids(rightKey), hideRight: ids(leftKey) };
    }

    /** CSS clip-path for the right map: show only right of the divider. */
    function clipInset(pos) {
        return `inset(0 0 0 ${(clampPosition(pos) * 100).toFixed(3)}%)`;
    }

    function clampPosition(pos) {
        return Math.min(0.98, Math.max(0.02, Number.isFinite(pos) ? pos : 0.5));
    }

    // ---------- DOM / map ----------

    function _visibility(id) {
        try { return _map.getLayoutProperty(id, 'visibility') || 'visible'; } catch { return 'none'; }
    }

    function _setVis(map, id, v) {
        try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v); } catch { /* layer gone */ }
    }

    // Cell-store datasets carry a real title; use it instead of the source id.
    function _label(g) {
        const m = /^cell-layer-src-(.+)$/.exec(g.key);
        const spec = m && typeof CellStore !== 'undefined' && CellStore.get ? CellStore.get(m[1]) : null;
        return spec && spec.title ? { ...g, label: spec.title } : g;
    }

    function _groups() { return overlayGroups(_map.getStyle().layers, _visibility).map(_label); }

    function _apply() {
        // Undo the last plan on the main map, then hide this plan's left-side set.
        _hiddenOnMain.forEach(id => _setVis(_map, id, 'visible'));
        const groups = _groups();
        const plan = visibilityPlan(groups, _left, _rightKey);
        plan.hideLeft.forEach(id => _setVis(_map, id, 'none'));
        _hiddenOnMain = plan.hideLeft;
        if (_right && _right.isStyleLoaded()) {
            groups.forEach(g => g.layerIds.forEach(id => _setVis(_right, id, 'visible')));
            plan.hideRight.forEach(id => _setVis(_right, id, 'none'));
        }
    }

    function _syncCamera() {
        if (!_right) return;
        _right.jumpTo({ center: _map.getCenter(), zoom: _map.getZoom(), bearing: _map.getBearing(), pitch: _map.getPitch() });
    }

    function _setPos(pos) {
        _pos = clampPosition(pos);
        if (!_wrap) return;
        _wrap.querySelector('.layer-swipe-map').style.clipPath = clipInset(_pos);
        _wrap.querySelector('.layer-swipe-divider').style.left = `${_pos * 100}%`;
        _wrap.querySelector('.layer-swipe-divider').setAttribute('aria-valuenow', String(Math.round(_pos * 100)));
    }

    function _buildPanel(groups) {
        _panel = document.createElement('div');
        _panel.id = PANEL_ID;
        _panel.className = 'layer-swipe-panel';
        _panel.setAttribute('role', 'group');
        _panel.setAttribute('aria-label', 'Swipe compare');
        const mk = (label, id, value) => {
            const wrap = document.createElement('label');
            wrap.className = 'layer-swipe-field';
            wrap.textContent = label;
            const sel = document.createElement('select');
            sel.id = id;
            const none = document.createElement('option');
            none.value = ''; none.textContent = '(same as other side)';
            sel.appendChild(none);
            groups.forEach(g => {
                const o = document.createElement('option');
                o.value = g.key; o.textContent = g.label;
                sel.appendChild(o);
            });
            sel.value = value;
            wrap.appendChild(sel);
            return { wrap, sel };
        };
        const title = document.createElement('div');
        title.className = 'layer-swipe-title';
        title.textContent = 'Swipe compare';
        const L = mk('Left only', 'layer-swipe-left', _left);
        const R = mk('Right only', 'layer-swipe-right', _rightKey);
        L.sel.addEventListener('change', () => { _left = L.sel.value; _apply(); });
        R.sel.addEventListener('change', () => { _rightKey = R.sel.value; _apply(); });
        const hint = document.createElement('div');
        hint.className = 'layer-swipe-hint';
        hint.textContent = groups.length
            ? 'Drag the divider. Layers not picked show on both sides.'
            : 'Turn on two layers first, then pick one for each side.';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'layer-swipe-close';
        close.textContent = 'Close';
        close.addEventListener('click', () => { toggle(); _syncButton(false); });
        _panel.append(title, L.wrap, R.wrap, hint, close);
        document.body.appendChild(_panel);
    }

    function _syncButton(on) {
        const btn = document.getElementById('btn-swipe');
        if (!btn) return;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }

    function _bindDivider(divider) {
        const toPos = (clientX) => {
            const r = _wrap.getBoundingClientRect();
            _setPos((clientX - r.left) / r.width);
        };
        divider.addEventListener('pointerdown', (e) => {
            divider.setPointerCapture(e.pointerId);
            const move = ev => toPos(ev.clientX);
            const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); };
            divider.addEventListener('pointermove', move);
            divider.addEventListener('pointerup', up);
        });
        divider.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') { _setPos(_pos - 0.02); e.preventDefault(); }
            if (e.key === 'ArrowRight') { _setPos(_pos + 0.02); e.preventDefault(); }
        });
    }

    function open() {
        if (typeof MapModule === 'undefined' || typeof maplibregl === 'undefined') return false;
        _map = MapModule.getMap();
        if (!_map || _wrap) return !!_wrap;
        const groups = _groups();
        // Default: the two most recently added overlays, one per side.
        if (!_left && !_rightKey && groups.length >= 2) {
            _left = groups[groups.length - 2].key;
            _rightKey = groups[groups.length - 1].key;
        }

        _wrap = document.createElement('div');
        _wrap.id = WRAP_ID;
        _wrap.className = 'layer-swipe-wrap';
        const holder = document.createElement('div');
        holder.className = 'layer-swipe-map';
        const divider = document.createElement('div');
        divider.className = 'layer-swipe-divider';
        divider.tabIndex = 0;
        divider.setAttribute('role', 'slider');
        divider.setAttribute('aria-label', 'Swipe divider');
        divider.setAttribute('aria-valuemin', '0');
        divider.setAttribute('aria-valuemax', '100');
        _wrap.append(holder, divider);
        _map.getContainer().parentNode.insertBefore(_wrap, _map.getContainer().nextSibling);

        _right = new maplibregl.Map({
            container: holder,
            style: _map.getStyle(),
            center: _map.getCenter(), zoom: _map.getZoom(), bearing: _map.getBearing(), pitch: _map.getPitch(),
            interactive: false, attributionControl: false,
            canvasContextAttributes: { preserveDrawingBuffer: true },
        });
        _right.on('load', _apply);
        _onMove = _syncCamera;
        _onResize = () => _right && _right.resize();
        _map.on('move', _onMove);
        _map.on('resize', _onResize);
        _bindDivider(divider);
        _setPos(_pos);
        _buildPanel(groups);
        _apply();
        return true;
    }

    function close() {
        if (_map) {
            _hiddenOnMain.forEach(id => _setVis(_map, id, 'visible'));
            if (_onMove) _map.off('move', _onMove);
            if (_onResize) _map.off('resize', _onResize);
        }
        _hiddenOnMain = [];
        _onMove = _onResize = null;
        if (_right) { try { _right.remove(); } catch { /* already gone */ } _right = null; }
        if (_wrap) { _wrap.remove(); _wrap = null; }
        if (_panel) { _panel.remove(); _panel = null; }
        _left = ''; _rightKey = '';
    }

    function isActive() { return !!_wrap; }
    function toggle() { if (_wrap) close(); else open(); }

    return { open, close, toggle, isActive, overlayGroups, visibilityPlan, clipInset, clampPosition, prettify };
})();

if (typeof window !== 'undefined') window.LayerSwipe = LayerSwipe;
