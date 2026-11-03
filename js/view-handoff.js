/**
 * ViewHandoff — keeps what you were looking at when you switch 2D ↔ 3D.
 *
 * Going to 3D:
 *   - the active cell layer carries over onto the buildings: when nothing
 *     colours them yet, they take the top cell layer's field (the flat layer
 *     still tints the ground beneath them), and follow that layer's field
 *     changes while 3D is on;
 *   - a selected cell that's on screen becomes the camera's pivot, so the
 *     tilt swings around it instead of the map centre.
 * Coming back to 2D, a colour set this way is cleared again; one the user
 * picked in the Building data panel is left alone. While buildings carry a
 * cell layer's colours its flat wash is dimmed so the two don't compete. The
 * selection and the detail panel are untouched both ways.
 *
 * autoColorKey() and pivotFor() are pure (unit-tested).
 */
const ViewHandoff = (() => {
    let _auto = null;      // BuildingData colour key this module set, or null
    let _is3d = false;
    const GROUND_OPACITY = 0.22;   // the cell layer's wash under buildings that carry its colours
    const FLAT_OPACITY = 0.6;      // CellLayers' own flat fill opacity

    /**
     * Building colour key for the top active cell layer ("<dataset>:<field>"),
     * or null when buildings are already coloured by something else. Pure.
     *   active: CellLayers.active() (top layer last), stateOf(id) → { field },
     *   current: BuildingData colour key now, auto: the key we set last time.
     */
    function autoColorKey(active, stateOf, current, auto) {
        if (current && current !== auto) return null;          // the user's own choice wins
        const ids = (active || []).slice().reverse();
        for (const id of ids) {
            const st = stateOf ? stateOf(id) : null;
            if (st && st.field) return `${id}:${st.field}`;
        }
        return null;
    }

    /**
     * Camera pivot [lng, lat] for a selected cell's bounds when its centre is
     * inside the view bounds, else null (an off-screen selection isn't
     * dragged back into view). Pure.
     */
    function pivotFor(cell, view) {
        if (!cell || !view) return null;
        const lat = (cell.south + cell.north) / 2, lng = (cell.west + cell.east) / 2;
        if (!(lat > view.south && lat < view.north && lng > view.west && lng < view.east)) return null;
        return [lng, lat];
    }

    function _map() {
        return typeof MapModule !== 'undefined' && MapModule.getMap ? MapModule.getMap() : null;
    }

    function _cellBounds(code) {
        if (!code || typeof DigiPin === 'undefined' || !DigiPin.decodePartial) return null;
        try {
            const b = DigiPin.decodePartial(code);
            const bb = b && (b.bounds || b);
            return bb && bb.south != null ? bb : null;
        } catch { return null; }
    }

    /** Dim (or restore) the flat fill of the cell layer the buildings are coloured by. */
    function _ground() {
        const map = _map();
        if (!map || typeof CellLayers === 'undefined') return;
        const dimId = _auto ? _auto.slice(0, _auto.indexOf(':')) : null;
        for (const id of CellLayers.active()) {
            const lyr = 'cell-layer-' + id;
            try {
                if (map.getLayer(lyr) && map.getLayer(lyr).type === 'fill') {
                    map.setPaintProperty(lyr, 'fill-opacity', id === dimId ? GROUND_OPACITY : FLAT_OPACITY);
                }
            } catch { /* layer rebuilding */ }
        }
    }

    function _syncColor() {
        if (typeof BuildingData === 'undefined' || typeof CellLayers === 'undefined') return;
        const cur = BuildingData.get().color;
        if (!_is3d) {
            if (_auto && cur === _auto) BuildingData.set({ color: null });
            _auto = null;
            _ground();
            return;
        }
        const key = autoColorKey(CellLayers.active(), CellLayers.state, cur, _auto);
        if (key && key !== cur) {
            _auto = key;
            BuildingData.set({ color: key });
        } else if (!key && _auto && cur === _auto) {
            // The last cell layer went away: hand the buildings back their theme look.
            BuildingData.set({ color: null });
            _auto = null;
        }
        _ground();
    }

    function _pivot() {
        const map = _map();
        const code = typeof MapModule !== 'undefined' && MapModule.getSelectedCode ? MapModule.getSelectedCode() : null;
        if (!map || !code) return;
        const b = map.getBounds && map.getBounds();
        const view = b && { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
        const c = pivotFor(_cellBounds(code), view);
        if (!c) return;
        // Replaces the toolbar's plain tilt (same pitch and timing) with one centred on the cell.
        map.easeTo({ center: c, pitch: Math.max(map.getPitch(), 60), duration: 1000 });
    }

    function _onToggle() {
        const btn = document.getElementById('btn-3d');
        const on = !!(btn && btn.classList.contains('active'));
        if (on === _is3d) return;
        _is3d = on;
        if (on) _pivot();
        _syncColor();
    }

    function init() {
        if (typeof document === 'undefined') return;
        const btn = document.getElementById('btn-3d');
        if (!btn) return;
        _is3d = btn.classList.contains('active');
        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(_onToggle).observe(btn, { attributes: true, attributeFilter: ['class'] });
        }
        if (typeof CellLayers !== 'undefined' && CellLayers.onChange) CellLayers.onChange(() => { if (_is3d) _syncColor(); });
    }

    return { init, autoColorKey, pivotFor };
})();

if (typeof window !== 'undefined') {
    window.ViewHandoff = ViewHandoff;
}
